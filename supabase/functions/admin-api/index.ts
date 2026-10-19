// admin-api — Edge Function do painel administrativo do NastaDesk.
//
// Segurança: valida o JWT do usuário, confirma que ele é o admin (tabela
// nastaclin_admins OU id/email do dono) e só então executa leituras de TODAS
// as clínicas/assinaturas e as RPCs admin usando a service_role. A service_role
// NUNCA vai para o front — fica apenas aqui, no ambiente da função.
//
// Deploy (via MCP/CLI) com verify_jwt = false: a autenticação é feita aqui
// dentro (getUser + checagem de admin), o que também permite tratar o
// preflight CORS (OPTIONS) corretamente.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const ADMIN_ID = "5759cf56-c0c2-4fe2-918e-c064ec101481";
const ADMIN_EMAIL = "em8090594@gmail.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_CUSTOS = {
  moeda: "BRL",
  ferramentas: [
    { id: "supabase", nome: "Supabase", ativo: false, modelo: "fixo", valor: 135, nota: "Banco, Auth e Edge Functions. Plano Pro ~ US$25/mes. Hoje no free tier." },
    { id: "vercel", nome: "Vercel", ativo: false, modelo: "fixo", valor: 108, nota: "Hospedagem do front. Plano Pro ~ US$20/mes. Hoje no Hobby (gratis)." },
    { id: "mercadopago", nome: "Mercado Pago (taxas)", ativo: true, modelo: "percentual_receita", percentual: 4.98, nota: "Taxa de 4,98% sobre cada assinatura recebida." },
    { id: "digitalocean", nome: "Servidor Evolution / WhatsApp", ativo: true, modelo: "faixas_clinicas", faixas: [{ ate: 10, valor: 32 }, { ate: 25, valor: 65 }, { ate: 50, valor: 130 }, { ate: 100, valor: 259 }, { ate: null, valor: 518 }], nota: "DigitalOcean. A RAM cresce com o no de clinicas (US$6=1GB na 1a faixa). Ajuste as faixas conforme escalar." },
    { id: "claude", nome: "API Claude / Anthropic", ativo: true, modelo: "uso_real_ia", preco_input_usd_milhao: 1.0, preco_output_usd_milhao: 5.0, preco_cache_escrita_usd_milhao: 1.25, preco_cache_leitura_usd_milhao: 0.10, cambio_brl: 5.40, nota: "Bot de WhatsApp em Haiku 4.5. Custo REAL com base nos tokens consumidos por cada clinica no mes. Os mesmos precos valem para a trava de custo do robo." },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Cotação USD->BRL ao vivo. Várias fontes gratuitas (sem chave) em cascata, para
// ser resiliente a indisponibilidade / limite de uma delas. Em memória cacheia o
// último valor por 10 min (reduz chamadas externas e sobrevive a um 429
// pontual). Se nada vier, devolve null e o painel usa o câmbio manual.
type Cambio = { valor: number; hora: string; fonte: string };
let _cambioCache: { dado: Cambio; ts: number } | null = null;
const CAMBIO_TTL_MS = 10 * 60 * 1000;

async function buscarUSDBRL(): Promise<Cambio | null> {
  // 1) AwesomeAPI (cotação intradiária)
  try {
    const r = await fetch("https://economia.awesomeapi.com.br/json/last/USD-BRL", { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      const bid = Number(j?.USDBRL?.bid);
      if (bid && isFinite(bid)) return { valor: bid, hora: new Date().toISOString(), fonte: "AwesomeAPI" };
    }
  } catch { /* tenta a próxima fonte */ }
  // 2) open.er-api.com (atualização frequente)
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      const brl = Number(j?.rates?.BRL);
      if (brl && isFinite(brl)) return { valor: brl, hora: new Date().toISOString(), fonte: "ER-API" };
    }
  } catch { /* tenta a próxima fonte */ }
  // 3) Frankfurter (BCE, diária) — último recurso
  try {
    const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL", { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      const brl = Number(j?.rates?.BRL);
      if (brl && isFinite(brl)) return { valor: brl, hora: new Date().toISOString(), fonte: "Frankfurter" };
    }
  } catch { /* sem fonte disponível */ }
  return null;
}

async function cambioUSDBRL(): Promise<Cambio | null> {
  const agora = Date.now();
  if (_cambioCache && (agora - _cambioCache.ts) < CAMBIO_TTL_MS) return _cambioCache.dado;
  const dado = await buscarUSDBRL();
  if (dado) {
    _cambioCache = { dado, ts: agora };
    return dado;
  }
  // Falhou agora: devolve o último valor conhecido (se houver) em vez de nada.
  return _cambioCache ? _cambioCache.dado : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "no_token" }, 401);

    // Valida o JWT e descobre quem é o usuário.
    const authClient = createClient(SUPABASE_URL, ANON);
    const { data: userData, error: userErr } = await authClient.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401);
    const user = userData.user;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Porteiro: precisa ser admin (tabela nastaclin_admins) OU o dono conhecido.
    const { data: adminRow } = await admin
      .from("nastaclin_admins")
      .select("nome,user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    const isAdmin = !!adminRow ||
      user.id === ADMIN_ID ||
      (user.email || "").toLowerCase() === ADMIN_EMAIL;
    if (!isAdmin) return json({ error: "forbidden" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "bootstrap";

    if (action === "bootstrap") {
      // Início do mês corrente no fuso de São Paulo (para "gasto do mês").
      const ymd = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      const [ano, mes] = ymd.split("-");
      const inicioMes = `${ano}-${mes}-01T00:00:00-03:00`;

      // Trava de IA: histórico dos últimos 6 meses (1º dia do mês, 5 meses atrás).
      const d6 = new Date(Date.UTC(Number(ano), Number(mes) - 1 - 5, 1));
      const inicio6m = d6.toISOString().slice(0, 10);

      const [clinicasRes, assinaturasRes, cfgRes, usoAggRes, cuponsRes, usosRes, sitesRes, cfgPubRes, cambioVivo, limitesRes, cotaRes, eventosRes] = await Promise.all([
        admin.from("clinicas")
          .select("id,nome,responsavel,whatsapp,email,plano,ativo,cortesia,cortesia_expira_em,criado_em,user_id")
          .order("criado_em", { ascending: false }),
        admin.from("assinaturas")
          .select("id,clinica_id,plano,periodo,status,valor,provedor,criado_em,proximo_pagamento,atualizado_em")
          .order("criado_em", { ascending: false }),
        admin.from("admin_config").select("value").eq("key", "custos").maybeSingle(),
        // Soma feita no banco (a API limita a 1.000 linhas; somar aqui subestimaria o custo).
        admin.rpc("admin_ia_uso_mes", { p_inicio: inicioMes }),
        admin.from("cupons").select("*").order("criado_em", { ascending: false }),
        admin.from("cupom_usos").select("*").order("usado_em", { ascending: false }).limit(1000),
        admin.from("sites").select("*").order("criado_em", { ascending: false }),
        admin.from("config_publica").select("chave,valor"),
        cambioUSDBRL(),
        admin.from("admin_config").select("value").eq("key", "ia_limites").maybeSingle(),
        admin.from("ia_cota_mensal").select("*").gte("mes", inicio6m).order("mes", { ascending: false }),
        admin.from("ia_cota_eventos").select("*").gte("mes", inicio6m).order("criado_em", { ascending: false }),
      ]);

      // Fallback: se a RPC ainda não existir (migração não aplicada), lê as
      // linhas como antes.
      let usoRes: { data: any[] | null; error: any } = usoAggRes as any;
      if (usoAggRes.error) {
        usoRes = await admin.from("ia_uso")
          .select("clinica_id,input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens")
          .gte("criado_em", inicioMes);
      }

      // Agrega o uso de IA do mês por clínica. Se a tabela ainda não existir
      // (migração não aplicada), usoRes.error vem preenchido — devolvemos vazio.
      const porClinica: Record<string, { clinica_id: string; chamadas: number; input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }> = {};
      for (const r of (usoRes.data || [])) {
        const k = r.clinica_id as string;
        const acc = porClinica[k] || (porClinica[k] = { clinica_id: k, chamadas: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
        acc.chamadas += r.chamadas !== undefined ? Number(r.chamadas || 0) : 1;
        acc.input_tokens += Number(r.input_tokens || 0);
        acc.output_tokens += Number(r.output_tokens || 0);
        acc.cache_creation_input_tokens += Number(r.cache_creation_input_tokens || 0);
        acc.cache_read_input_tokens += Number(r.cache_read_input_tokens || 0);
      }

      const configPublica: Record<string, unknown> = {};
      for (const r of (cfgPubRes.data || [])) configPublica[(r as any).chave] = (r as any).valor;

      return json({
        admin: { nome: adminRow?.nome || user.email },
        clinicas: clinicasRes.data || [],
        assinaturas: assinaturasRes.data || [],
        custos: cfgRes.data?.value || DEFAULT_CUSTOS,
        cupons: cuponsRes.data || [],
        cupom_usos: usosRes.data || [],
        sites: sitesRes.data || [],
        config_publica: configPublica,
        uso_ia: {
          periodo: `${ano}-${mes}`,
          disponivel: !usoRes.error,
          clinicas: Object.values(porClinica),
        },
        // Trava de IA: limites configurados + totais por clínica/mês + marcos atingidos.
        ia_cota: {
          disponivel: !cotaRes.error,
          limites: limitesRes.data?.value || null,
          meses: cotaRes.data || [],
          eventos: eventosRes.data || [],
        },
        cambio_vivo: cambioVivo,
      });
    }

    if (action === "salvar_ia_limites") {
      // Valida e normaliza: número >= 0 ou null (sem limite). Nunca aceita lixo.
      const l = body.limites;
      if (!l || typeof l !== "object" || !l.planos || typeof l.planos !== "object") return json({ error: "limites_invalidos" }, 400);
      const num = (v: unknown) => (v === "" || v === null || v === undefined) ? null : (isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : NaN);
      const plano = (p: any, bloqueiaPadrao: boolean) => ({
        bloqueia: p && typeof p.bloqueia === "boolean" ? p.bloqueia : bloqueiaPadrao,
        conversas_mes: num(p?.conversas_mes),
        teto_custo_brl: num(p?.teto_custo_brl),
      });
      const limpo = {
        definicao: "conversa_dia",
        limite_diario_telefone: num(l.limite_diario_telefone),
        alertas_pct: [80, 100],
        planos: { profissional: plano(l.planos.profissional, true), premium: plano(l.planos.premium, false) },
      };
      const todos = [limpo.limite_diario_telefone, limpo.planos.profissional.conversas_mes, limpo.planos.profissional.teto_custo_brl,
        limpo.planos.premium.conversas_mes, limpo.planos.premium.teto_custo_brl];
      if (todos.some((v) => typeof v === "number" && isNaN(v))) return json({ error: "valores_precisam_ser_numeros_positivos" }, 400);
      const { error } = await admin.from("admin_config").upsert({ key: "ia_limites", value: limpo, updated_at: new Date().toISOString() });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, limites: limpo });
    }

    if (action === "cambio") {
      return json({ cambio_vivo: await cambioUSDBRL() });
    }

    if (action === "salvar_custos") {
      const cfg = body.config;
      if (!cfg || typeof cfg !== "object") return json({ error: "config_invalida" }, 400);
      const { error } = await admin.from("admin_config").upsert({
        key: "custos",
        value: cfg,
        updated_at: new Date().toISOString(),
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "conceder_cortesia") {
      const clinica_id = body.clinica_id;
      const plano = body.plano || "premium";
      const dias = (body.dias === undefined || body.dias === null || body.dias === "") ? null : Number(body.dias);
      if (!clinica_id) return json({ error: "clinica_id_obrigatorio" }, 400);
      const { error } = await admin.rpc("admin_conceder_cortesia", {
        p_clinica_id: clinica_id,
        p_plano: plano,
        p_dias: dias,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "remover_acesso") {
      const clinica_id = body.clinica_id;
      if (!clinica_id) return json({ error: "clinica_id_obrigatorio" }, 400);
      const { error } = await admin.rpc("admin_remover_acesso", { p_clinica_id: clinica_id });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ---------- CUPONS DE PARCERIA ----------
    if (action === "salvar_cupom") {
      const c = body.cupom;
      if (!c || !c.codigo || !c.parceiro_nome) return json({ error: "codigo_e_parceiro_obrigatorios" }, 400);
      const linha: Record<string, unknown> = {
        codigo: String(c.codigo).toUpperCase().replace(/\s/g, ""),
        parceiro_nome: c.parceiro_nome,
        parceiro_contato: c.parceiro_contato || null,
        parceiro_chave_pix: c.parceiro_chave_pix || null,
        tipo_desconto: c.tipo_desconto === "valor" ? "valor" : "percentual",
        valor_desconto: Number(c.valor_desconto) || 0,
        duracao_meses: (c.duracao_meses === null || c.duracao_meses === undefined || c.duracao_meses === "") ? null : Number(c.duracao_meses),
        aplica_em: ["assinatura", "site", "ambos"].includes(c.aplica_em) ? c.aplica_em : "ambos",
        comissao_tipo: ["percentual", "valor", "nenhuma"].includes(c.comissao_tipo) ? c.comissao_tipo : "percentual",
        comissao_valor: Number(c.comissao_valor) || 0,
        comissao_recorrente: !!c.comissao_recorrente,
        ativo: c.ativo !== false,
        validade: c.validade || null,
        limite_usos: (c.limite_usos === null || c.limite_usos === undefined || c.limite_usos === "") ? null : Number(c.limite_usos),
        observacao: c.observacao || null,
        atualizado_em: new Date().toISOString(),
      };
      if (Number(linha.valor_desconto) <= 0) return json({ error: "desconto_precisa_ser_maior_que_zero" }, 400);
      const r = c.id
        ? await admin.from("cupons").update(linha).eq("id", c.id)
        : await admin.from("cupons").insert(linha);
      if (r.error) return json({ error: r.error.message }, 400);
      return json({ ok: true });
    }

    if (action === "excluir_cupom") {
      if (!body.cupom_id) return json({ error: "cupom_id_obrigatorio" }, 400);
      // O histórico de uso NÃO é apagado: cupom_usos.cupom_id vira null e o
      // código continua gravado, então o repasse já apurado nunca se perde.
      const { error } = await admin.from("cupons").delete().eq("id", body.cupom_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "marcar_comissao") {
      const ids: string[] = Array.isArray(body.uso_ids) ? body.uso_ids : [];
      if (!ids.length) return json({ error: "uso_ids_obrigatorio" }, 400);
      const paga = body.paga !== false;
      const { error } = await admin.from("cupom_usos")
        .update({ comissao_paga: paga, comissao_paga_em: paga ? new Date().toISOString() : null })
        .in("id", ids);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "status_uso_cupom") {
      // Marca um uso como confirmado/cancelado na mão (ex.: cliente pagou por fora).
      if (!body.uso_id) return json({ error: "uso_id_obrigatorio" }, 400);
      const st = ["pendente", "confirmado", "cancelado"].includes(body.status) ? body.status : null;
      if (!st) return json({ error: "status_invalido" }, 400);
      const { error } = await admin.from("cupom_usos")
        .update({ status: st, confirmado_em: st === "confirmado" ? new Date().toISOString() : null })
        .eq("id", body.uso_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ---------- SITES DAS CLÍNICAS ----------
    if (action === "salvar_site") {
      const st = body.site;
      if (!st || !st.clinica_id) return json({ error: "clinica_id_obrigatorio" }, 400);
      const status = ["solicitado", "em_producao", "no_ar", "cancelado"].includes(st.status) ? st.status : "solicitado";
      const linha: Record<string, unknown> = {
        clinica_id: st.clinica_id,
        status,
        url: st.url || null,
        valor_cobrado: (st.valor_cobrado === "" || st.valor_cobrado === null || st.valor_cobrado === undefined) ? null : Number(st.valor_cobrado),
        valor_pago: (st.valor_pago === "" || st.valor_pago === null || st.valor_pago === undefined) ? null : Number(st.valor_pago),
        gratuito: !!st.gratuito,
        cupom_codigo: st.cupom_codigo ? String(st.cupom_codigo).toUpperCase() : null,
        observacao: st.observacao || null,
        entregue_em: status === "no_ar" ? (st.entregue_em || new Date().toISOString()) : null,
        atualizado_em: new Date().toISOString(),
      };
      // Vinculado à clínica: 1 registro por clínica (upsert pela unique de clinica_id).
      const { data: existente } = await admin.from("sites").select("id,solicitado_em,origem").eq("clinica_id", st.clinica_id).maybeSingle();
      const r = existente
        ? await admin.from("sites").update(linha).eq("id", existente.id)
        : await admin.from("sites").insert({ ...linha, origem: "admin", solicitado_em: new Date().toISOString() });
      if (r.error) return json({ error: r.error.message }, 400);
      return json({ ok: true });
    }

    if (action === "excluir_site") {
      if (!body.clinica_id) return json({ error: "clinica_id_obrigatorio" }, 400);
      const { error } = await admin.from("sites").delete().eq("clinica_id", body.clinica_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ---------- CONFIG PÚBLICA (links de checkout + dados do site) ----------
    if (action === "salvar_config_publica") {
      const chave = body.chave;
      if (!["checkout_links", "site", "demo"].includes(chave)) return json({ error: "chave_invalida" }, 400);
      if (!body.valor || typeof body.valor !== "object") return json({ error: "valor_invalido" }, 400);
      const { error } = await admin.from("config_publica").upsert({
        chave, valor: body.valor, atualizado_em: new Date().toISOString(),
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "acao_desconhecida" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

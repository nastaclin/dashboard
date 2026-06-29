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
    { id: "claude", nome: "API Claude / Anthropic", ativo: true, modelo: "uso_real_ia", preco_input_usd_milhao: 1.0, preco_output_usd_milhao: 5.0, cambio_brl: 5.40, nota: "Bot de WhatsApp em Haiku 4.5. Custo REAL com base nos tokens consumidos por cada clinica no mes (US$1/1M entrada, US$5/1M saida). Ajuste os precos e o cambio se mudarem." },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
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

      const [clinicasRes, assinaturasRes, cfgRes, usoRes] = await Promise.all([
        admin.from("clinicas")
          .select("id,nome,responsavel,whatsapp,email,plano,ativo,cortesia,cortesia_expira_em,criado_em,user_id")
          .order("criado_em", { ascending: false }),
        admin.from("assinaturas")
          .select("id,clinica_id,plano,status,valor,provedor,criado_em,proximo_pagamento,atualizado_em")
          .order("criado_em", { ascending: false }),
        admin.from("admin_config").select("value").eq("key", "custos").maybeSingle(),
        admin.from("ia_uso")
          .select("clinica_id,input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens")
          .gte("criado_em", inicioMes),
      ]);

      // Agrega o uso de IA do mês por clínica. Se a tabela ainda não existir
      // (migração não aplicada), usoRes.error vem preenchido — devolvemos vazio.
      const porClinica: Record<string, { clinica_id: string; input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }> = {};
      for (const r of (usoRes.data || [])) {
        const k = r.clinica_id as string;
        const acc = porClinica[k] || (porClinica[k] = { clinica_id: k, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
        acc.input_tokens += Number(r.input_tokens || 0);
        acc.output_tokens += Number(r.output_tokens || 0);
        acc.cache_creation_input_tokens += Number(r.cache_creation_input_tokens || 0);
        acc.cache_read_input_tokens += Number(r.cache_read_input_tokens || 0);
      }

      return json({
        admin: { nome: adminRow?.nome || user.email },
        clinicas: clinicasRes.data || [],
        assinaturas: assinaturasRes.data || [],
        custos: cfgRes.data?.value || DEFAULT_CUSTOS,
        uso_ia: {
          periodo: `${ano}-${mes}`,
          disponivel: !usoRes.error,
          clinicas: Object.values(porClinica),
        },
      });
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

    return json({ error: "acao_desconhecida" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

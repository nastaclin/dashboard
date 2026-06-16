# NastaDesk — Painel Admin

Painel administrativo pessoal do **NastaDesk** (SaaS de gestão de clínicas).
Página estática (`index.html`) que consome o backend Supabase do app principal.

Backend Supabase: projeto `zrkadblxozddreiwruhv`.

## Seções

- **Visão geral** — clientes ativos, MRR (assinaturas ativas), custos mensais e margem.
- **Clientes** — todas as clínicas com plano, status (Ativa / Cortesia / Sem plano / Suspensa), status da assinatura e receita/mês.
- **Assinaturas** — concede cortesia (`admin_conceder_cortesia`) a quem está sem plano e remove acesso (`admin_remover_acesso`).
- **Custos** — estimativa mensal do stack conforme o nº de clientes ativos. Ferramentas hoje gratuitas aparecem **desativadas** com um toggle; ao ligar, entram no cálculo. Valores editáveis e persistidos.

## Segurança (importante)

A **service_role NUNCA** fica no front. Toda leitura de todas as clínicas/assinaturas
e toda ação administrativa passa pela Edge Function **`admin-api`**, que:

1. valida o JWT do usuário logado;
2. confirma que ele é o admin (tabela `nastaclin_admins` ou id/email do dono);
3. só então usa a `service_role` para ler os dados e chamar as RPCs admin.

O front só tem a **anon key** e o JWT da sessão do admin. As RPCs
`admin_conceder_cortesia` / `admin_remover_acesso` têm `execute` apenas para
`service_role` (não para `anon`/`authenticated`), então não há como chamá-las
direto do navegador.

## Estrutura

```
index.html                              # painel (estático, single-file)
supabase/functions/admin-api/index.ts   # Edge Function admin (cópia versionada)
supabase/migrations/                     # tabela admin_config (parâmetros de custos)
```

## Modelo de custos

Cada ferramenta tem um modelo de cálculo, todos editáveis no painel:

| Ferramenta | Modelo | Base |
|---|---|---|
| Supabase | fixo (desativado) | plano Pro quando virar pago |
| Vercel | fixo (desativado) | plano Pro quando virar pago |
| Mercado Pago | % da receita | 4,98% por assinatura recebida |
| Servidor Evolution/WhatsApp | faixas por nº de clínicas | DigitalOcean, RAM cresce com a base |
| API Claude/Anthropic | por clínica ativa | bot WhatsApp em Haiku 4.5 (~R$3/clínica/mês) |

Os parâmetros ficam em `public.admin_config` (chave `custos`) e são lidos/gravados
pela Edge Function. Ajuste os números pelo painel quando quiser.

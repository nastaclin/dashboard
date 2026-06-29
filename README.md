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
| API Claude/Anthropic | **uso real por clínica** | custo calculado a partir dos tokens consumidos no mês (Haiku 4.5: US$1/1M entrada, US$5/1M saída), convertido para R$ |

Os parâmetros ficam em `public.admin_config` (chave `custos`) e são lidos/gravados
pela Edge Function. Ajuste os números pelo painel quando quiser.

### Custo real da API Claude por cliente

O card **API Claude/Anthropic** não usa mais uma estimativa fixa por clínica. Ele
mostra o **gasto real**: quantos tokens cada clínica consumiu no chatbot do WhatsApp
no mês corrente e o custo correspondente em R$ e US$.

- O consumo é registrado na tabela `public.ia_uso` (projeto NastaDesk), gravada pela
  Edge Function `whatsapp-webhook` a cada chamada ao Claude. O registro é tolerante a
  falhas — se a gravação falhar, o bot continua respondendo normalmente.
- A `admin-api` agrega o uso do mês por clínica no `bootstrap` (campo `uso_ia`).
- Os preços (US$/1M entrada e saída) são editáveis no painel.
- O câmbio US$→R$ é buscado **ao vivo** pela `admin-api` em fontes gratuitas em
  cascata (AwesomeAPI → open.er-api → Frankfurter, sem chave), com cache de 10 min,
  e o painel atualiza a cada 10 min; se todas falharem, usa o câmbio manual de fallback.
- **Não há histórico anterior ao deploy**: o gasto só passa a ser medido a partir do
  momento em que o rastreio entra no ar. Antes disso o card mostra R$ 0 com um aviso.

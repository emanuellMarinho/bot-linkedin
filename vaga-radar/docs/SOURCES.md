# Fontes públicas e permissões

Documentação e endpoints consultados nesta implementação em 23/10/2026. Todas as requisições feitas pelo aplicativo são **GET** de quadros públicos. A existência de consulta pública não é interpretada como autorização para candidatura programática.

## Greenhouse Job Board API

- Documentação oficial: https://developers.greenhouse.io/job-board.html
- O site de documentação retornou bloqueio de acesso nesta máquina. A documentação foi consultada no repositório oficial público: https://github.com/grnhse/greenhouse-api-docs/tree/271cd888061d3428575eba2f626fe3e1996485c3/source/includes/job-board
- Endpoint: `https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true`
- `id`, `title`, `content`, `location.name`, `absolute_url`, `updated_at`. `first_published`, quando presente na resposta, é usado como publicação; `updated_at` nunca substitui publicação.
- Conteúdo pode vir com entidades HTML; o adaptador converte para texto, preservando quebras de bloco.
- GET não exige autenticação segundo a documentação oficial. Nenhum endpoint POST de candidatura é utilizado.
- Quadro real validado: `vtex`.

## Lever Postings API

- Documentação oficial: https://github.com/lever/postings-api
- Endpoint global: `https://api.lever.co/v0/postings/{board}?mode=json`
- `id`, `text`, `descriptionPlain`, `lists`, `additionalPlain`, `categories`, `workplaceType`, `hostedUrl`, `applyUrl`.
- A API retorna todas as vagas do site por padrão; `skip` e `limit` são opcionais e não são usados na consulta completa do MVP.
- `categories.commitment=FullTime` é armazenado em `employmentType`, sem conversão para CLT.
- `createdAt` observado em respostas reais não é tratado como data de publicação: a lista de campos públicos documentados não estabelece essa equivalência. Publicação permanece nula.
- Instância europeia (`api.eu.lever.co`) não está habilitada neste MVP; use o identificador da instância global. Não há envio programático de candidaturas.
- Quadro real validado: `ciandt`. O quadro `lever` respondeu com lista vazia; isso não foi tratado como erro de autenticação.

## Ashby Public Job Posting API

- Documentação oficial: https://developers.ashbyhq.com/docs/public-job-posting-api
- Endpoint: `https://api.ashbyhq.com/posting-api/job-board/{board}`
- Campos: `title`, `location`, `secondaryLocations`, `isRemote`, `workplaceType`, `descriptionPlain`/`descriptionHtml`, `publishedAt`, `employmentType`, `jobUrl`, `applyUrl` e `isListed`.
- `id` é preservado se presente, com deduplicação por URL caso ausente. A documentação pública não exige ID no contrato básico.
- `publishedAt` significa **última publicação** segundo a documentação, podendo representar republicação. Não é confundida com coleta nem com primeira publicação.
- `isListed=false` não entra na coleta. Compensação só é exibida se recebida; o MVP não solicita o parâmetro opcional `includeCompensation=true`.
- Quadro real validado: `ashby`. Há diversas restrições internacionais nesse quadro; remoto sozinho não comprova elegibilidade no Brasil.

## LinkedIn e importação manual

Nenhuma API privada, scraping, login automatizado, cookie, CAPTCHA ou Easy Apply. Links são registrados sem consulta pelo backend. O parser de alertas utiliza somente texto ou `.eml` fornecido pelo usuário. Links diretos de vaga são normalizados pelo ID e preparados para revisão dos campos restantes.

O usuário abre o anúncio/formulário original e conclui a candidatura por conta própria. O sistema registra envio somente mediante confirmação explícita e transição válida.

## Rede e operação

Domínios de consulta: `boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com`. Documentação: `developers.greenhouse.io`, `developers.ashbyhq.com`, `github.com` e `raw.githubusercontent.com`. npm: `registry.npmjs.org`; download de binários assinados/integridade de dependências pode usar domínios GitHub já previstos no ambiente.

Uma chamada por fonte a cada coleta, fontes consultadas sequencialmente. Timeouts de 20 segundos por tentativa, até três tentativas para HTTP 429/502/503/504, backoff curto e respeito a Retry-After. Pedidos com espera maior que três segundos encerram a fonte com erro para uma coleta posterior. Respostas acima de 12 MB, formatos inválidos e redirecionamentos são recusados. Desative fontes ou pause a coleta no painel; requisições em andamento são canceladas ao pausar globalmente.

Não há limite universal de consulta presumido como garantia: monitore avisos e ajuste a frequência às regras de cada provedor. Erros e horários de verificação/sucesso ficam no banco. Falhas não são substituídas por dados fictícios.

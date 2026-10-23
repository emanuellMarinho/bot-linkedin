# API REST local

Base interna: `/api`. JSON UTF-8; POST/PUT/PATCH com payload JSON usam `Content-Type: application/json`. Sem CORS público. A instância atende somente localhost; Host/Origin externos são recusados. Falhas usam `{ "error": "mensagem", "details": [{"field":"campo","message":"motivo"}] }` quando aplicável. Códigos: 400 validação, 403 origem/host, 404 ausente, 409 conflito/transição/pausa, 413 corpo grande, 415 tipo de conteúdo, 500 erro interno.

| Método / caminho            | Comportamento                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /health`               | Estado do banco e coleta                                                                                       |
| `GET /dashboard`            | Indicadores e última execução                                                                                  |
| `GET /jobs`                 | Listagem paginada e filtros abaixo                                                                             |
| `GET /jobs/:id`             | Dados, inferências, motivos, fontes e candidatura/histórico                                                    |
| `POST /jobs/import`         | Importação manual, retorna `{job,inserted}` e 201/200                                                          |
| `PATCH /jobs/:id`           | `{status}` com `saved`, `discarded`, `new`, `reviewing`; transições são validadas                              |
| `POST /jobs/:id/score`      | Recalcula compatibilidade                                                                                      |
| `POST /jobs/:id/prepare`    | Cria/atualiza preparação local e transita por análise/preparada                                                |
| `GET /applications`         | Candidaturas com vagas e histórico                                                                             |
| `POST /applications`        | `{jobId}` inicia acompanhamento, sem envio                                                                     |
| `PATCH /applications/:id`   | `{status?,notes?,resumeId?,confirmedSent?}`                                                                    |
| `GET /transitions`          | Mapa de transições válidas                                                                                     |
| `GET /profile`              | Perfil, habilidades confirmadas ou não e metadados de currículos                                               |
| `PUT /profile`              | Substitui campos do perfil/habilidades e recalcula scores                                                      |
| `GET /settings`             | Preferências, pesos e nomenclaturas                                                                            |
| `PUT /settings`             | Substitui configurações completas, valida pesos=100, reagenda e recalcula                                      |
| `GET /sources`              | Fontes e resultados da última verificação                                                                      |
| `POST /sources`             | `{provider,board,company,enabled?}`                                                                            |
| `PATCH /sources/:id`        | `{enabled:boolean}`                                                                                            |
| `POST /collection/run`      | Executa coleta, retorna resultado; 409 se outra já estiver ativa ou coleta pausada                             |
| `GET /collection/history`   | Até 50 execuções, com erros e duração                                                                          |
| `GET /notifications`        | Até 100 avisos internos                                                                                        |
| `POST /notifications/read`  | Marca avisos como lidos                                                                                        |
| `POST /alerts/parse`        | JSON `{text}` ou multipart `file` (.eml); retorna texto/links para revisão, sem cadastrar vaga automaticamente |
| `POST /resumes`             | Multipart `file`: PDF/TXT até 2 MB                                                                             |
| `GET /resumes/:id/download` | Download privado local como anexo                                                                              |

## Importação

Obrigatórios: `title`, `company`, `url` HTTP(S) público sem credenciais. Campos opcionais: `description`, `applicationUrl`, `location`, `modality` (`remote/hybrid/onsite`), `seniority` (`junior/mid/senior`), `requiredSkills`, `desiredSkills`, `contractType`, `salary`, `publishedAt`, `updatedAt`, `applicantCount`, `applicantEvidence`, `publicationEvidence`.

Datas em ISO 8601 com fuso, ou nulas. `publishedAt` manual exige `publicationEvidence` e não pode ser futura. `applicantCount` é inteiro não negativo ou nulo; se informada, exige `applicantEvidence`. As evidências são declarações do usuário, não confirmação independente do provedor. Arrays desconhecidos devem ser nulos para preservar a distinção das inferências. HTML da descrição é convertido para texto. Campos adicionais são recusados.

```json
{
  "title": "Desenvolvedor Node.js Pleno",
  "company": "Empresa cujo anúncio você revisou",
  "url": "https://example.org/vagas/123",
  "description": "Descrição fornecida pelo usuário",
  "location": null,
  "publishedAt": null,
  "applicantCount": null
}
```

O exemplo é ilustrativo e não é uma oportunidade real. A aplicação não busca essa URL.

## Filtros de vagas

`q`, `title`, `company`, `technology`, `seniority`, `modality`, `source`, `contract`, `status`, `minScore` (0–100), `hours` (janela verificável), `competition` (`0-10`, `11-25`, `26-50`, `51+`, `unknown`), `eligibleOnly=true`, `relevance` (`relevant`, `all`, `excluded`), `sort` (`score`, `date`, `competition`), `page` (inicial=1) e `limit` (1–100, padrão=30). Retorna `{items,total,page,limit}`. A interface usa `relevance=relevant` inicialmente; a API sem esse filtro retorna todas as vagas para inspeção.

## Perfil

`PUT /profile` recebe `name`, `summary`, `experiences:[{company,role,description,period}]`, `skills:[{name,verified}]`, `seniority` ou nulo, `professionalLinks:[]`, `additional`. O campo `resumes` é somente leitura e não deve ser reenviado. `verified=true` representa confirmação do próprio usuário, não certificação externa.

## Configurações

Edite o objeto retornado por GET e envie o objeto completo em PUT. Campos: `country`, `modalities`, `seniorities`, `contracts`, `weights:{technical,seniority,location,recency,contract}`, `primaryHours`, `secondaryDays`, `maxApplicants`, `minScore`, `collectionEnabled`, `intervalHours`, `notificationsEnabled`, `excludeSenior`, `keywordGroups:{grupo:[termos]}`. Pesos somam 100. Intervalos aceitos: 1, 2, 3, 4, 6, 8, 12 ou 24 horas; execução em horários fixos UTC. `maxApplicants` só identifica concorrência conhecida favorável/desempate, sem alterar o score.

## Status

`new → saved/reviewing/discarded`; `saved → reviewing/discarded`; `reviewing → prepared/saved/discarded`; `prepared → started/reviewing/discarded`; `started → sent/prepared/discarded`; `sent → interview/rejected/discarded`; `interview → offer/rejected/discarded`; `offer → rejected/discarded`; `rejected → reviewing/discarded`; `discarded → new`.

Somente `started → sent` com `confirmedSent:true` registra envio. Nenhum endpoint envia candidatura a plataforma externa. A preparação auxilia as transições até `prepared`; abrir links é independente. Notas e seleção do currículo podem ser alteradas sem transição; eventos ficam registrados.

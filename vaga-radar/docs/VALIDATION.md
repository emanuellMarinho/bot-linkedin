# Validação da entrega

Verificações executadas no ambiente Linux Debian 13 x86_64, Node.js **24.19.0**, npm **11.9.0**, em 23/10/2026. Os testes com fixtures e a coleta real são resultados distintos. Nenhuma candidatura real foi enviada e nenhum dado pessoal foi inventado no banco principal.

## Comandos executados e resultados

| Comando                                                        | Resultado observado                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm install --no-audit --no-fund --cache /tmp/vaga-npm-cache` | Dependências instaladas; better-sqlite3 compatível com o ambiente             |
| `npm ci --no-audit --no-fund --cache /tmp/vaga-npm-cache`      | Instalação reproduzida pelo lockfile, inclusive pelo script salvo do ambiente |
| `npm start`                                                    | Servidor inicializado em loopback, health e listagem reais responderam        |
| `npm run dev` com porta/dados isolados                         | Watch iniciou, reiniciou após alterações e respondeu health/listagem          |
| `npm test`                                                     | **27 testes passaram**, 0 falhas, 0 ignorados, 0 cancelados                   |
| `npm run test:ui`                                              | Passou em Chromium desktop 1440×1000 e mobile 390×844                         |
| `npm audit --omit=dev --audit-level=high`                      | 0 vulnerabilidades relatadas no momento da consulta                           |
| `npm run sources:example` repetido                             | Fontes configuradas sem duplicação ou sobrescrita                             |
| `npm run collect` — primeira execução real                     | 276 recebidas, 276 novas, 0 erros                                             |
| `npm run collect` — repetição real                             | 276 recebidas, 0 novas, 276 já conhecidas, 0 erros; cerca de 7,4 segundos     |
| `DATA_DIR=/tmp/vaga-radar-demo-smoke npm run demo` repetido    | 3 vagas de demonstração em banco separado; segunda execução não duplicou      |
| `PRAGMA integrity_check`                                       | `ok` no banco persistente                                                     |

## Integrações reais

GETs autorizados pelos endpoints públicos, sem credenciais:

- Greenhouse / `vtex`: **31** vagas.
- Lever / `ciandt`: **176** vagas.
- Ashby / `ashby`: **69** vagas.

Os horários, erros e resultados estão registrados em `collection_runs` e `sources` no banco. Os totais representam o que foi retornado durante a validação, não uma garantia de disponibilidade futura ou compatibilidade. Vagas sem boa correspondência permanecem sinalizadas e podem ser inspecionadas pela opção **Todas as coletadas**.

A rede inicialmente bloqueou essas consultas. Os domínios foram adicionados ao rascunho da configuração e as três APIs responderam na instância atual posteriormente. A documentação do Greenhouse foi acessada pelo repositório oficial no GitHub, pois seu site de documentação continuou bloqueado. Lever e Ashby tiveram documentação oficial consultada; detalhes em SOURCES.md.

## Cobertura funcional e de segurança

Unitários e integração: extração de tecnologias e seções, normalização, datas, score/justificativas, geografia desconhecida/restrita, ausência de contagens, concorrência separada, todas as fontes com fixtures, backoff/Retry-After, alertas texto/.eml, deduplicação por URL/ID e entre fontes, preservação de IDs distintos no mesmo quadro, SQLite após reabertura, migrations repetíveis, perfil/configurações, filtros, currículo privado, histórico e transições válidas. O agendador foi exercitado por callback de cron controlado, sem esperar quatro horas, incluindo frequência, pausa e cancelamento de requisição em andamento; o servidor real registrou a agenda para operação contínua.

O fluxo de ponta a ponta foi exercitado com dados explicitamente fictícios: coleta de fixture de API → SQLite → classificação → filtros → detalhes → perfil/habilidades confirmadas → currículo → preparação → candidatura iniciada → confirmação manual de envio → histórico. A coleta real foi verificada separadamente e suas vagas não receberam candidaturas de teste.

Segurança básica: recusa de URL inválida/privada e credenciais embutidas, board malicioso/SSRF, redirecionamentos, origem/Host externos, conteúdo não JSON, score/pesos inválidos, contagem sem evidência, HTML externo/XSS, payload SQL, formato de currículo inválido e acesso direto indevido a arquivos privados.

Chromium: seis telas, desktop e mobile sem overflow horizontal, sem erros de JavaScript/console; formulários de perfil/experiência, currículo, fonte, filtros, preparação, anotações, seleção de currículo, transições, importação de alerta e vaga manual. Também testou Escape no modal e persistência do tema claro. Screenshots em `test-results/` (ignorados pelo Git); fixtures estão identificadas como DEMONSTRAÇÃO. O painel da instância com vagas reais também foi carregado e capturado sem usar automação nos serviços do LinkedIn.

Um erro no atributo HTML `pattern` foi identificado pelo Chromium, corrigido e o teste foi repetido com sucesso. A extração de tecnologias foi otimizada com expressões pré-compiladas após observar o custo de processar descrições reais. Não há falha conhecida remanescente nas verificações executadas. Testes visuais abrangeram Chromium Linux; outros navegadores e um WSL2 real não foram executados.

## Configuração salva versus publicação

Foram persistidos no rascunho `install_script` (Node 24, npm ci e testes), `start_skill` (diretório, inicialização, readiness, agendamento e preservação de dados) e cinco domínios adicionais de APIs/documentação. Não foram adicionados requisitos de segredo. O script de instalação foi executado nesta máquina, incluindo os testes.

Essa persistência não publica o ambiente nem comprova restauração em uma tarefa nova. Revise e salve as alterações nas configurações do ambiente e depois publique pelo produto. O servidor é local; não foi criado preview público.

## Limitações remanescentes

Nenhuma credencial externa bloqueia o MVP. O usuário ainda precisa fornecer seu perfil e currículo reais e escolher empresas de interesse. Matching, datas e geografia dependem das informações anunciadas e de regras heurísticas; restrições complexas precisam de revisão humana. Não há autenticação remota, envio programático, integração de mailbox ou sincronização automática de encerramento de vagas. Essas extensões não foram simuladas como funcionalidades entregues.

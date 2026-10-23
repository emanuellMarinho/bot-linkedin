# Vaga Radar

Aplicativo local para descobrir oportunidades em fontes públicas autorizadas, comparar requisitos com seu perfil e preparar candidaturas. Backend Node.js/Express, SQLite persistente e interface HTML/CSS/JavaScript puro. Sem API key, assinatura ou IA externa no MVP.

## Instalação e execução

Requer **Node.js 24 LTS**, npm e Linux ou WSL2. O `better-sqlite3` usa binário compatível quando disponível; para compilar localmente, são necessários Python 3, `make` e compilador C++. Chromium é necessário apenas nos testes visuais.

```bash
cd /workspace/bot-linkedin/vaga-radar
npm ci
# Opcional: crie .env a partir de .env.example para mudar porta/diretório.
npm run sources:example
npm start
```

O servidor fica em `127.0.0.1:3000`. No seu Linux/WSL2, abra esse endereço em seu navegador. No onboarding em nuvem, a validação é interna; não há preview público. O comando `npm run sources:example` adiciona os quadros públicos VTEX/Greenhouse, CI&T/Lever e Ashby/Ashby sem sobrescrever fontes já existentes. Eles são exemplos configuráveis de empresas reais, não uma indicação de que todas as vagas são elegíveis. A coleta não é executada automaticamente ao adicionar uma fonte: use **Atualizar radar** ou `npm run collect` com o servidor ativo.

```bash
npm run dev           # Reinício automático do servidor durante desenvolvimento
npm run collect       # Coleta manual via API local; servidor precisa estar ativo
npm test              # Testes unitários, banco, adaptadores, API e integração
npm run test:ui       # Chromium headless, desktop e mobile, banco isolado
```

Para o teste visual, instale o Chromium do sistema pela distribuição, quando necessário, ou configure `CHROMIUM_PATH=/caminho/do/chromium`. A execução usa `playwright-core` e não baixa outro navegador. No ambiente desta entrega o executável é `/usr/bin/chromium`. Os scripts do servidor usam `--use-env-proxy` para respeitar proxies HTTP(S) fornecidos pelo ambiente, sem modificar certificados ou desabilitar TLS.

### Variáveis de ambiente

| Nome                | Padrão              | Uso                                                                                  |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `HOST`              | `127.0.0.1`         | Somente endereços de loopback são permitidos                                         |
| `PORT`              | `3000`              | Porta local                                                                          |
| `DATA_DIR`          | `./data`            | Banco e currículos privados; relativo ao diretório de execução                       |
| `LOG_LEVEL`         | `info`              | Logs estruturados Pino, sem conteúdo de perfil ou requisições                        |
| `SCHEDULER_ENABLED` | `true`              | `false` desativa o agendamento; coleta manual continua disponível se ativa no painel |
| `CHROMIUM_PATH`     | `/usr/bin/chromium` | Navegador dos testes visuais                                                         |

Não são necessárias credenciais para as três APIs de consulta. `.env`, banco, currículos e resultados de testes ficam fora do Git. Não há senha, cookie nem token do LinkedIn.

## Funcionalidades

- Dashboard com indicadores calculados do banco, fontes verificadas, progresso e notificações internas.
- Consulta modular de Greenhouse, Lever e Ashby por identificador de quadro, com timeouts, limite de resposta, backoff para erros transitórios e recusa de redirecionamentos.
- Importação manual de vagas e leitura de texto/.eml fornecido pelo usuário, sem conexão com a caixa postal ou acesso automatizado ao LinkedIn.
- Campos desconhecidos nulos; publicação, atualização e coleta são armazenadas separadamente. Contagem manual exige evidência informada pelo usuário.
- Deduplicação por ID da fonte, URL canônica e empresa/cargo/localização conhecida. IDs diferentes no mesmo quadro são preservados. Referências de múltiplas fontes são mantidas.
- Quatro grupos editáveis de nomenclaturas em português/inglês, com normalização de caixa, acentos e grafias simples.
- Filtros por texto/cargo, empresa, tecnologia, senioridade, modalidade, fonte, recência, score, contratação, elegibilidade e concorrência conhecida. Paginação e ordenação por relevância, publicação e concorrência.
- Matching determinístico de 0–100 com pesos editáveis, motivos, lacunas, informações ausentes e incompatibilidades. Cargos fora das nomenclaturas e restrições incompatíveis ficam sinalizados; a tela Explorar começa com vagas dentro dos critérios e permite ver todas.
- Perfil editável, experiências, links, habilidades e currículos PDF/TXT versionados em armazenamento privado.
- Assistente local de candidaturas com templates. Apenas habilidades confirmadas pelo usuário podem aparecer como experiência declarada; as habilidades iniciais são critérios de busca e começam sem confirmação.
- Acompanhamento com dez status, histórico imutável de transições, notas e currículo selecionado.
- Agendamento a cada quatro horas por padrão, bloqueio de concorrência, pausa/cancelamento, configuração por fonte e histórico de duração/erros/resultados.
- Interface responsiva, tema escuro inicial, tema claro, navegação por teclado, estados vazios, carregamento e feedback de erros.

## Como usar do início ao fim

1. Em **Meu perfil**, informe seu nome, resumo e experiências reais. Marque somente habilidades que você declara possuir; remova ou adicione critérios conforme necessário. Adicione uma versão do currículo.
2. Em **Fontes e configurações**, cadastre os quadros de empresas desejadas e ajuste preferências, nomenclaturas, pesos e frequência. Clique em **Coletar agora** e confira o histórico.
3. Em **Explorar vagas**, filtre por tecnologias, senioridade e publicação. Vagas sem publicação verificável não entram no filtro de recência. A ausência de contagem nunca recebe rótulo de baixa concorrência.
4. Abra **Ver detalhes** para ler a descrição, motivos do score, restrições, lacunas e campos desconhecidos. Salve ou descarte oportunidades conforme sua avaliação.
5. Clique em **Preparar candidatura**, revise o rascunho e selecione o currículo adequado. Nenhuma qualificação é gerada sem dados fornecidos.
6. Abra o formulário original e conclua a candidatura por sua conta. **Abrir o link não registra envio.** No acompanhamento, marque **Candidatura iniciada**. Depois de enviar na plataforma, assinale a confirmação e clique em **Registrar envio confirmado**.
7. Atualize entrevistas, propostas, rejeições e anotações em **Candidaturas**. O histórico é preservado.

Para alertas de e-mail, use **Importar oportunidade → Importar alerta de e-mail**. Selecione um link extraído e preencha cargo/empresa antes de importar. O parser não tenta adivinhar esses campos. Arquivos `.eml` anexos não são executados nem publicados.

## Matching e qualidade dos dados

Pesos iniciais: técnica 40, senioridade 20, modalidade/localização 20, recência 10 e contratação 10. Obrigatórias e desejáveis são separadas a partir de seções reconhecidas ou campos fornecidos; menções avulsas recebem peso técnico reduzido. A pontuação usa habilidades como critérios de compatibilidade e não atesta experiência.

Informações desconhecidas não ganham pontos. FullTime não equivale a CLT. Remoto não equivale a elegível no Brasil: o motor procura evidência geográfica e mantém casos ambíguos como desconhecidos. Exclusões limitam o score a 25 e ficam explícitas. A extração é heurística e requer revisão humana, especialmente em anúncios complexos, multilíngues ou com exceções regionais.

Concorrência é um atributo separado, sem acrescentar pontos ao score. Conhecida e dentro da preferência, ela pode desempatar scores iguais. A ordem por concorrência coloca valores ausentes por último. Não existe contagem estimada por horas de publicação.

Veja [fontes e permissões](docs/SOURCES.md), [API REST](docs/API.md) e [validação desta entrega](docs/VALIDATION.md).

## Persistência e arquitetura

O banco `data/radar.sqlite` usa WAL, chaves estrangeiras, transações, consultas parametrizadas e migrations SQL versionadas. O diretório `data/resumes/` contém currículos com nomes internos aleatórios e permissões privadas. Os arquivos não são servidos por `express.static`; download ocorre por endpoint local controlado. Para backup, pare o servidor e copie **todo o diretório de dados**, incluindo os currículos e eventuais arquivos WAL/SHM. Preserve o banco entre execuções; não é necessário reseedar.

```text
src/
  app.js, server.js, config.js, validation.js, utils.js
  database/              migrations e repositório SQLite
  providers/             interface fetchJobs e três adaptadores de consulta
  modules/               matching, templates de candidatura e parser de alertas
  services/              coleta, coordenação e agendamento
public/                  seis telas em HTML/CSS/JS sem framework
tests/                   testes e fixtures explicitamente fictícias
scripts/                 coleta local, exemplos de fontes, demo e teste Chromium
```

`TemplateAssistantProvider.prepare(job, profile)` é a interface para eventual provedor de IA opcional. Não há integração com IA externa ativa.

## Demonstração isolada

As fixtures são fictícias e usadas apenas por testes. O banco corrente da entrega contém vagas reais coletadas, sem candidaturas de teste. Para experimentar com exemplos, use um diretório separado:

```bash
DATA_DIR=./data/demo npm run demo
DATA_DIR=./data/demo PORT=3001 npm start
```

O comando demo insere somente registros identificados como **DEMONSTRAÇÃO**. Não coleta vagas reais nem envia candidaturas. Os testes usam bancos temporários separados e os removem ao terminar. Screenshots do teste visual ficam em `test-results/` e mostram dados de demonstração.

## Segurança, permissões e limites

Aplicação pessoal, local e sem autenticação. Ela recusa exposição em `0.0.0.0`, valida Host/Origin, bloqueia requisições cross-site, aplica CSP/Helmet, valida payloads com Zod e não renderiza HTML externo como HTML. A API limita uploads a 2 MB e exige PDF/TXT para currículos. Arquivos e dados pessoais não vão para logs.

Somente os três endpoints HTTPS fixos dos provedores são acessados pelo backend. URLs importadas são armazenadas e abertas pelo usuário; nunca buscadas pelo backend. Identificadores de quadros não aceitam URLs, caminhos ou endereços privados. Nenhum envio externo de candidatura foi implementado.

Não exponha por proxy reverso/túnel nem compartilhe esta instância sem antes implementar autenticação, autorização, TLS, controles de sessão, limites por usuário e proteção de dados adequada. O download local privado não substitui autorização por usuário em um serviço remoto.

Limitações atuais: regras de extração e geografia são heurísticas; as fontes podem não informar publicação, salário, senioridade, contratação ou contagens; encerramento de vagas na origem não é sincronizado como confirmação de indisponibilidade; não há sincronização de mailbox, Telegram, envio de e-mail ou candidatura programática. Fontes ausentes ou bloqueadas geram erros no histórico, sem fallback silencioso para fixtures. O agendador precisa do processo Node ativo e não executa coletas perdidas enquanto o servidor esteve desligado.

## Licença

Veja a [licença do repositório](../LICENSE).

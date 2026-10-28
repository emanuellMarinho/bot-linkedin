# Vaga Radar Bot

Bot sem dashboard obrigatório: lê um currículo local, procura vagas em fontes públicas, classifica compatibilidade e gera um currículo PDF/TXT por oportunidade. Trabalha em uma janela diária configurável de **12 horas**, inicialmente **08h–20h, America/Sao_Paulo**, com consultas periódicas (uma hora no exemplo). Dúvidas podem ser encaminhadas ao candidato por WhatsApp. GPT é opcional.

**Estado:** execução Node/Linux e integrações com fixtures testáveis. O envio real depende de permissões da plataforma; WhatsApp/GPT dependem de credenciais configuradas. O pacote Windows é gerado e testado pelo workflow Windows, não por uma compilação Linux disfarçada de `.exe`. Não há candidatura automática universal para qualquer site.

## Começar sem interface

Requer Node.js 24 LTS. Linux e Windows são os alvos; Windows usa o pacote portátil ou Node instalado.

```bash
cd vaga-radar
npm ci
cp bot.example.json bot.config.json
# Edite bot.config.json e indique seu currículo em applicant.resumePath.
npm run bot -- --config bot.config.json --once
npm start
```

No Windows, copie o arquivo pelo Explorer ou use `Copy-Item bot.example.json bot.config.json`. `npm start` executa o bot continuamente, sem escutar porta HTTP. `npm run bot -- --help` mostra as opções. O bot sem configuração cria um arquivo de exemplo e encerra com código 2, sem envios. Configuração inválida também encerra com código 2; falha de coleta em ciclo único retorna 1; sucesso ou espera fora do horário retorna 0.

Campos principais:

- `applicant.resumePath`: PDF com texto extraível ou TXT UTF-8, até 2 MB. PDFs escaneados precisam de OCR externo antes do uso. O currículo original não é alterado.
- `profile`: nome, resumo, experiências e habilidades declaradas, conforme disponíveis. Não invente os dados ausentes; nome/e-mail podem ser perguntados ao candidato pelo WhatsApp após encontrar uma vaga compatível.
- `preferences`: país, senioridades, modalidades, contratos, score mínimo, nomenclaturas e intervalo. O exemplo usa Brasil e uma consulta por hora, e preserva o motor de pontuação da versão anterior.
- `sources`: quadros Greenhouse, Lever e Ashby. O arquivo é declarativo: fontes não listadas ficam pausadas, sem apagar histórico. Apenas uma execução do bot por diretório de dados é permitida.
- `workWindow`: início, duração e fuso. Fora da janela não começa novo ciclo; o processo deve continuar aberto. Uma requisição já iniciada pode terminar após o horário de fechamento.
- `autoApply`: desativado inicialmente, limites por ciclo e por 24h, e integrações explicitamente autorizadas.
- `ai` e `whatsapp`: opções detalhadas abaixo.

Os caminhos relativos são resolvidos em relação ao arquivo de configuração. Banco, perguntas, respostas, currículos e relatórios ficam em `dataDir`, fora de `public/` e do Git. Credenciais ficam em variáveis de ambiente ou no `.env` **local**, ao lado do arquivo de configuração; nunca dentro do currículo, configuração versionada ou WhatsApp.

## Currículo e adaptação ATS

Para cada vaga relevante, o bot cria PDF pesquisável com uma coluna e TXT em `data/tailored/`, além do pacote da candidatura em `data/outbox/`. O objetivo cita explicitamente a vaga alvo. Habilidades destacadas precisam estar confirmadas no perfil e evidenciadas no currículo; o conteúdo factual original inteiro é preservado. Não são criados cargos, datas, empresas, certificações ou resultados.

Essa adaptação melhora a apresentação para leitura automática; **não garante nota nem aprovação em ATS**. O PDF original continua disponível e as versões são identificadas por conteúdo. Os relatórios em `data/reports/latest.json` e `questions.json` mostram o que foi preparado, enviado ou bloqueado. A saída do terminal contém contagens, sem currículo ou segredos.

## GPT opcional

```json
"ai": {
  "enabled": true,
  "apiKeyEnv": "VAGA_OPENAI_KEY",
  "model": "gpt-4.1-mini"
}
```

Defina a chave verdadeira em `VAGA_OPENAI_KEY` no ambiente local. Ativar essa opção autoriza transmitir **texto do currículo, vaga e habilidades confirmadas** à API OpenAI; há cobrança conforme sua conta. O bot usa Responses API com `store:false`, limites de saída e timeout. Não existe chave embutida nem chamada paga durante os testes.

O modelo propõe ordenação de habilidades já existentes e perguntas sobre dados ausentes. Não recebe autorização para inventar experiência ou responder fatos pessoais pelo candidato. Descrição da vaga é tratada como conteúdo não confiável. Planos válidos são armazenados por currículo/vaga/modelo para não repetir chamadas idênticas. Se a IA estiver desativada ou indisponível, a preparação determinística continua e a limitação aparece no relatório.

## Perguntas e respostas por WhatsApp

É uma integração com a **WhatsApp Business Platform Cloud API oficial**. Não usa automação de WhatsApp pessoal ou WhatsApp Web. Requer conta/app Meta, número Business configurado, token válido, número do candidato e um **template aprovado**. Tarifas/regras dependem da conta Meta. Os testes locais não habilitam o canal real.

1. Cadastre um template, por exemplo `vaga_radar_duvida`, em `pt_BR`, com exatamente dois parâmetros no corpo: texto da pergunta e ID da pergunta. Exemplo de corpo a submeter à aprovação da Meta:

   `O Vaga Radar precisa de uma informação para continuar sua candidatura: {{1}}. Responda a esta mensagem no formato {{2}}: sua resposta.`

2. No arquivo `bot.config.json`, ative `whatsapp.enabled`, informe `phoneNumberId`, `to` (número autorizado com país/DDD, só dígitos), `templateName` e `language`. `apiVersion` é editável e precisa ser suportada pela sua app Meta.
3. Defina `VAGA_WHATSAPP_TOKEN` no ambiente do bot. O token não é enviado como texto ao candidato.
4. Para receber respostas, configure um webhook público **HTTPS** terminado em `/webhook`. O projeto entrega o receptor, mas não cria hospedagem ou túnel automaticamente. Esse receptor usa banco persistente compartilhado com o bot e pode ser executado no mesmo host.
5. Defina **valores locais reais**, não placeholders de proxy, para `VAGA_META_APP_SECRET` (verificar assinatura HMAC), `VAGA_WHATSAPP_VERIFY_TOKEN` (verificar o webhook) e `VAGA_WHATSAPP_TO` (remetente autorizado). São segredos locais de validação; não devem ser colados em chat ou commit.

```bash
npm run bot -- --config bot.config.json --whatsapp-webhook
# Alternativa com Node e diretório explícito:
VAGA_BOT_DATA_DIR=./data node --use-env-proxy src/whatsapp-server.js
```

Por padrão o receptor atende somente `127.0.0.1:3001`, sem painel nem acesso aos currículos. Configure um terminador HTTPS ou hospede o receptor com `VAGA_WHATSAPP_HOST`/`VAGA_WHATSAPP_PORT` explícitos. O receptor verifica assinatura dos bytes originais, remetente autorizado e deduplica IDs das mensagens. Não exponha o dashboard antigo por esse caminho.

Responda no formato **`ID_DA_PERGUNTA: resposta`**. Exemplo: `PROFILE_NAME: Meu nome profissional`. Perguntas de habilidades aceitam `sim` ou `não`, e e-mail precisa ser válido. IDs conhecidos e ainda pendentes são aceitos; texto sem ID, remetentes externos, respostas duplicadas e assinaturas inválidas não alteram dados. Um recibo de envio da API significa aceitação pela Meta, não confirmação de entrega/leitura.

Respostas ficam no banco e o bot as verifica a cada dez segundos. Durante a janela de trabalho, pode retomar a preparação sem fazer nova coleta. Perguntas específicas da vaga bloqueiam apenas essa vaga; dados globais como nome e e-mail afetam candidaturas que dependem deles. Perguntas de IA respondidas ficam no pacote da candidatura. Formulários com campos adicionais não suportados ainda precisam de implementação própria; o bot não inventa respostas nem presume que todos os campos de uma plataforma têm o mesmo formato.

## Envio de candidaturas: capacidade e limites reais

O conector de envio implementado é o endpoint **oficial Lever**. A credencial é gerada por um **Super Admin da integração da empresa contratante**, não pelo login normal do candidato. Ter apenas uma conta LinkedIn/Lever não fornece essa permissão. O bot só envia a quadros cuja integração foi autorizada e cujo formulário mínimo é conhecido; campos/consentimentos específicos não estão mapeados neste MVP. Sem essa autorização, cria currículo e pacote, deixando a vaga pendente.

```json
"autoApply": {
  "enabled": true,
  "maxPerRun": 1,
  "maxPerDay": 3,
  "sources": [{
    "provider": "lever",
    "board": "quadro_autorizado",
    "apiKeyEnv": "VAGA_LEVER_KEY",
    "authorizationConfirmed": true
  }]
}
```

Exemplo de configuração, não autorização concedida. A chave verdadeira fica no ambiente local. Envio exige currículo válido, nome/e-mail, ausência de dúvidas pendentes, elegibilidade geográfica identificada, senioridade compatível, requisitos técnicos confirmados e limites respeitados. Datas conhecidas fora da janela são bloqueadas; data ausente permanece desconhecida e reduz o score, sem inventar recência.

O status enviada exige recibo verificável `applicationId` retornado pela API. Timeout, queda ou resultado ambíguo não são retentados automaticamente para evitar duplicatas; interrupção após iniciar envio exige reconciliação. Erros, rejeições e rate limits são registrados. Um recibo apenas comprova que a API aceitou a candidatura, não que alguém leu o currículo.

Greenhouse e Ashby continuam como fontes de consulta neste bot; candidaturas nessas plataformas e em outros sites ficam pendentes até haver conector autorizado específico. LinkedIn permanece por importação fornecida pelo usuário/abertura manual; não há login automatizado, cookies ou Easy Apply. Nada disso é apresentado como envio automático já disponível.

## Windows .exe

O workflow **Windows bot**, em `.github/workflows/windows-bot.yml`, compila com Node SEA em Windows x64, instala os módulos nativos corretos, executa os testes e faz smoke test do executável extraído. Também é possível compilar no Windows com Node 24:

```powershell
npm ci
npm run build:windows
```

Artefato: `dist/VagaRadar-Windows-x64.zip`. É um pacote portátil com **`VagaRadar.exe` e pasta `app/`**, não um único arquivo autossuficiente. Extraia tudo. Não apague a pasta `app`. O executável gerado não possui assinatura Authenticode própria.

```powershell
.\VagaRadar.exe --help
.\VagaRadar.exe --config .\bot.config.json --watch
```

O processo precisa permanecer ativo durante o horário configurado; para execução diária use o Agendador de Tarefas do Windows com esses argumentos e o diretório correto. Não foi instalado um serviço, criado agendamento no seu computador nem garantido funcionamento com a máquina desligada. Credenciais e dados pessoais ficam fora do ZIP distribuído.

## Testes e desenvolvimento

```bash
npm test           # Unitários, banco, pipeline bot, ATS, GPT, WhatsApp e envio com fixtures
npm run test:ui    # Regressão do painel opcional no Chromium local
npm run bot -- --help
```

Todos os envios externos dos testes são simulados, incluindo WhatsApp, GPT e Lever. O teste ATS gera e relê PDF de verdade. Não houve envio de candidatura, mensagem real nem uso pago de GPT nesta implementação. A janela foi testada com relógio controlado; isso não comprova doze horas ininterruptas de operação em produção.

O dashboard anterior é opcional e preservado: `npm run web` inicia Express apenas no localhost. Suas instruções REST estão em [docs/API.md](docs/API.md); fontes de consulta em [docs/SOURCES.md](docs/SOURCES.md). A [validação da versão anterior](docs/VALIDATION.md) registra seus resultados de 23/10/2026, não substituindo as verificações novas do bot.

## Dados e limites

Banco SQLite, currículos e respostas são pessoais. Não compartilhe `data/`, `.env` ou `bot.config.json`; faça backup com os processos encerrados. O programa não expõe arquivos privados nem contém credenciais. Não há OCR, envio universal, controle remoto do computador do usuário ou implantação contínua criada automaticamente. Integrações opcionais sem credencial permanecem desativadas. Licença: [MIT do repositório](../LICENSE).

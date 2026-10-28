# Vaga Radar Bot

Bot sem dashboard obrigatório: lê um currículo local, procura vagas em fontes públicas, classifica compatibilidade e gera um currículo PDF/TXT por oportunidade. Trabalha em uma janela diária configurável de **12 horas**, inicialmente **08h–20h, America/Sao_Paulo**, com consultas periódicas (uma hora no exemplo). Dúvidas podem ser respondidas no próprio terminal. O número pessoal do WhatsApp é salvo como destino; o envio por esse canal depende de um remetente já autenticado. GPT é opcional.

**Estado:** execução Node/Linux e integrações com fixtures testáveis. O envio real depende de permissões da plataforma; WhatsApp/GPT dependem de credenciais configuradas. O pacote Windows é gerado e testado pelo workflow Windows, não por uma compilação Linux disfarçada de `.exe`. Não há candidatura automática universal para qualquer site.

## Começar sem interface

Requer Node.js 24 LTS. Linux e Windows são os alvos; Windows usa o pacote portátil ou Node instalado.

Abra **VagaRadar.exe**. No primeiro uso, o terminal pergunta nome, e-mail, currículo, habilidades, número pessoal do WhatsApp, horários e integrações opcionais. As respostas são salvas automaticamente em `bot.config.json`, o currículo é copiado para a pasta privada e a rotina começa na mesma janela. O fluxo básico pergunta apenas seu número pessoal, sem QR code, cadastro Business ou credenciais Meta. Mantenha o terminal aberto; **Ctrl+C** encerra.

Para alterar os dados posteriormente:

```powershell
.\VagaRadar.exe --setup
```

Pressionar Enter mantém o valor anterior. As chaves ficam ocultas durante a digitação e nunca são mostradas como valores padrão. Ctrl+C durante o assistente cancela sem substituir a configuração anterior. A configuração é validada e salva de uma vez, sem JSON parcial.

No desenvolvimento com Node:

```bash
cd vaga-radar
npm ci
npm start
# Reconfigurar sem editar arquivos:
npm run bot -- --setup
```

`npm start` e o `.exe` sem argumentos permanecem em execução; não é preciso pedir `--watch`. `--once` executa apenas um ciclo. Em automação sem terminal, a ausência de configuração ainda cria um exemplo e retorna código 2, sem solicitar entradas ou enviar mensagens. `--setup` exige terminal interativo. Integrações externas continuam dependendo das permissões e credenciais da plataforma.

Campos principais:

- `applicant.resumePath`: PDF com texto extraível ou TXT UTF-8, até 2 MB. PDFs escaneados precisam de OCR externo antes do uso. O currículo original não é alterado.
- `profile`: nome, resumo, experiências e habilidades declaradas, conforme disponíveis. Não invente os dados ausentes; nome/e-mail podem ser perguntados ao candidato pelo WhatsApp após encontrar uma vaga compatível.
- `preferences`: país, senioridades, modalidades, contratos, score mínimo, nomenclaturas e intervalo. O exemplo usa Brasil e uma consulta por hora, e preserva o motor de pontuação da versão anterior.
- `sources`: quadros Greenhouse, Lever e Ashby. O arquivo é declarativo: fontes não listadas ficam pausadas, sem apagar histórico. Apenas uma execução do bot por diretório de dados é permitida.
- `workWindow`: início, duração e fuso. Fora da janela não começa novo ciclo; o processo deve continuar aberto. Uma requisição já iniciada pode terminar após o horário de fechamento.
- `autoApply`: desativado inicialmente, limites por ciclo e por 24h, e integrações explicitamente autorizadas.
- `ai` e `whatsapp`: opções detalhadas abaixo.

Os caminhos relativos são resolvidos em relação ao arquivo de configuração. Banco, perguntas, respostas, currículos e relatórios ficam em `dataDir`, fora de `public/` e do Git. As chaves digitadas no assistente ficam no campo `credentials` do **JSON local privado** (sem criptografia), ignorado pelo Git, com permissões restritas no Linux. Não compartilhe esse arquivo. Variáveis de ambiente e `.env` local continuam suportados; o assistente reutiliza credenciais existentes sem mostrá-las. Valores digitados explicitamente no JSON têm precedência no processo. Nenhuma chave é incluída no ZIP distribuído, no currículo ou em mensagens do WhatsApp.

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

Informe a chave no assistente do terminal ou defina `VAGA_OPENAI_KEY` no ambiente local. Ativar essa opção autoriza transmitir **texto do currículo, vaga e habilidades confirmadas** à API OpenAI; há cobrança conforme sua conta. O bot usa Responses API com `store:false`, limites de saída e timeout. Não existe chave embutida nem chamada paga durante os testes.

O modelo propõe ordenação de habilidades já existentes e perguntas sobre dados ausentes. Não recebe autorização para inventar experiência ou responder fatos pessoais pelo candidato. Descrição da vaga é tratada como conteúdo não confiável. Planos válidos são armazenados por currículo/vaga/modelo para não repetir chamadas idênticas. Se a IA estiver desativada ou indisponível, a preparação determinística continua e a limitação aparece no relatório.

## Dúvidas no terminal e número pessoal

Sem um serviço remetente conectado, o WhatsApp permanece **desativado**, mesmo após informar o número. Só o número de destino não autentica envio de mensagens. O assistente básico não pede QR code nem cadastro Business, conforme a preferência do usuário; não existe uma conexão pessoal ativa por trás desse campo.

As perguntas aparecem na janela do bot. Para responder, digite `ID_DA_PERGUNTA: sua resposta` e pressione Enter. A resposta é validada e salva, e a rotina continua sem precisar fechar o bot ou editar JSON. Mensagens já respondidas não substituem respostas anteriores. Ctrl+C continua encerrando a execução.

## Integração WhatsApp para operador que já tenha remetente

As instruções abaixo são opcionais e não fazem parte do assistente básico. Somente um operador com integração existente precisa de `VagaRadar.exe --advanced-setup` para cadastrar a API oficial. Informar apenas o número pessoal não cria esse serviço.

Seu **número pessoal pode receber** as perguntas e não precisa ser convertido em Business. O remetente do bot, por sua vez, precisa de uma conexão autenticada com o WhatsApp. A integração implementada nesta versão usa a **WhatsApp Business Platform Cloud API oficial**. Não usa automação de WhatsApp pessoal ou WhatsApp Web. Requer conta/app Meta, número Business configurado, token válido, número do candidato e um **template aprovado**. Tarifas/regras dependem da conta Meta. Os testes locais não habilitam o canal real. Cadastro/aprovação de app, template e disponibilidade de HTTPS são etapas da Meta/hospedagem que o executável não pode aprovar por conta própria.

O assistente básico pergunta seu número pessoal separadamente. Você termina a configuração sem API Business; nesse caso as perguntas ficam pendentes localmente e o WhatsApp não é anunciado como conectado. Informar somente um número não autentica um remetente.

1. Cadastre um template, por exemplo `vaga_radar_duvida`, em `pt_BR`, com exatamente dois parâmetros no corpo: texto da pergunta e ID da pergunta. Exemplo de corpo a submeter à aprovação da Meta:

   `O Vaga Radar precisa de uma informação para continuar sua candidatura: {{1}}. Responda a esta mensagem no formato {{2}}: sua resposta.`

2. No arquivo `bot.config.json`, ative `whatsapp.enabled`, informe `phoneNumberId`, `to` (número autorizado com país/DDD, só dígitos), `templateName` e `language`. `apiVersion` é editável e precisa ser suportada pela sua app Meta.
3. Defina `VAGA_WHATSAPP_TOKEN` no ambiente do bot. O token não é enviado como texto ao candidato.
4. Para receber respostas, informe ao assistente um webhook público **HTTPS** terminado em `/webhook`. Com o canal configurado, o receptor local inicia junto do bot, sem comando separado. O projeto entrega o receptor, mas não cria hospedagem ou túnel automaticamente. Esse receptor usa banco persistente compartilhado com o bot e pode ser executado no mesmo host.
5. O assistente gera um verify token automaticamente para uma configuração nova e guarda-o no JSON privado. Para configurações manuais, defina **valores locais reais**, não placeholders de proxy, para `VAGA_META_APP_SECRET` (verificar assinatura HMAC), `VAGA_WHATSAPP_VERIFY_TOKEN` (verificar o webhook) e `VAGA_WHATSAPP_TO` (remetente autorizado). São segredos locais de validação; não devem ser colados em chat ou commit.

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

[Baixe o pacote validado no Windows](https://github.com/emanuellMarinho/bot-linkedin/actions/runs/40611122506), na seção **Artifacts → VagaRadar-Windows-x64** (é necessário estar conectado ao GitHub). O build e o teste do executável extraído passaram.

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

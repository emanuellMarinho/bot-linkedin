# Validação do bot v2.3 — fluxo de terminal e SMS

Esta versão reorganiza o executável em etapas sequenciais e adiciona SMS como alternativa ao WhatsApp. A configuração, a conexão e o início da busca têm estados separados: uma etapa precisa terminar antes de a próxima começar.

## Escopo da versão atual

- Assistente com sete etapas numeradas, validação do currículo antes de prosseguir e revisão final antes de salvar. Cancelar preserva os arquivos anteriores.
- Layout de terminal adaptado à largura, menu numérico e respostas por números curtos. Comandos assíncronos são executados em ordem; atualizações não substituem texto que está sendo digitado.
- Inicialização aguarda a conexão WhatsApp ou a validação do serviço SMS antes de começar a coleta. Erros oferecem tentar novamente, configurar SMS, continuar explicitamente pelo terminal ou encerrar.
- SMS via Twilio REST, com credenciais locais e número remetente habilitado. O serviço consulta respostas recebidas sem webhook público e deduplica mensagens. A validação da conta não é apresentada como prova de entrega.
- Operações do pipeline expõem progresso ordenado e aguardam suas dependências. Dados importantes ausentes continuam pausando a candidatura para consulta ao candidato.
- Busca contínua, currículo factual ATS e conectores Lever da versão anterior são preservados; plataformas sem conector de envio continuam pendentes.

**Validação final desta versão:** registrar a contagem de testes, PTY e novo run Windows após os checks. Os resultados da versão 2.2 abaixo são históricos e não comprovam o executável com o novo layout/SMS.

Não houve uso de credenciais reais, SMS real, pareamento de WhatsApp ou candidatura em produção nos testes. SMS exige uma conta/provedor real, número compatível e eventuais tarifas/permissões geográficas. O funcionamento da conta precisa de teste de mensagem e resposta pelo canal configurado.

## Histórico da versão 2.2

# Validação do bot v2.2

Esta versão adiciona WhatsApp pessoal por QR code, acompanhamento por comandos no terminal/conversa com você mesmo, busca contínua com limites por fonte e envio inicial por formulários Lever compatíveis. Os resultados anteriores abaixo são históricos e não substituem a validação desta versão.

## Escopo e evidências da versão atual

- **WhatsApp pessoal:** dispositivo vinculado via Baileys, QR no terminal, sessão local privada em `data/whatsapp-session/`, verificação da conta conectada e restauração da sessão. O bot recebe respostas por ID ou citação da pergunta e restringe o fluxo à conversa da própria conta configurada.
- **Teste de conexão:** `--check-whatsapp` diagnostica sem enviar. `--test-whatsapp` só confirma o fluxo completo quando a resposta do candidato chega ao banco. Aceitação do transporte, entrega e leitura têm estados distintos. Perguntas de teste não entram na fila normal nem são reenviadas automaticamente.
- **WhatsApp Cloud:** configuração anterior preservada, com assinatura HMAC, validação de Phone Number ID, respostas citadas e callbacks de entrega/leitura/falha. Rejeições definitivas podem ser revistas após corrigir a configuração; resultados ambíguos não são repetidos automaticamente.
- **Busca contínua:** sem espera fixa de uma hora entre rodadas. Há intervalo técnico mínimo de 30 segundos por fonte, persistência de cooldown e espera adicional para erros/`Retry-After`, evitando repetição imediata ao reiniciar.
- **Acompanhamento:** comandos `vagas`, `candidaturas`, `vaga ID` e `ajuda` usam o banco persistido e mostram pontuação, estado, link e pendências. A mesma visão é usada no terminal e na conversa WhatsApp autenticada.
- **Formulários:** suporte inicial ao formulário público hospedado em `jobs.lever.co`; campos obrigatórios desconhecidos geram perguntas. Confirmação de envio precisa ser observada na plataforma; não é inventado um `applicationId` no modo navegador.
- **ATS/GPT:** preparação factual do currículo preservada. GPT opcional não recebe autorização para inventar experiência ou responder dados pessoais desconhecidos. Não há garantia de aprovação em ATS.

Validação local final: **131 testes passaram**, sem falhas, cancelamentos ou ignorados. Inclui seis testes dos formulários Lever com Chromium real e respostas/consentimentos fictícios, oito testes da sessão pessoal e oito de busca contínua/acompanhamento. `npm run bot -- --doctor` carregou os módulos reais de WhatsApp, QR, navegador, PDF e SQLite sem rede. O teste com PTY confirmou processo contínuo, comandos `vagas`/`candidaturas` e Ctrl+C com saída 0. A regressão desktop/mobile do painel opcional passou. `npm audit --omit=dev --audit-level=high`: zero vulnerabilidades relatadas.

As instruções reutilizáveis e os domínios de WhatsApp/Lever foram salvos no rascunho do ambiente; isso não publica hospedagem nem conecta uma conta. **Windows validado:** [run 40615734776](https://github.com/emanuellMarinho/bot-linkedin/actions/runs/40615734776), fonte `7c55f52`, status Success em **6m25s**. Passaram instalação pelo lockfile, suíte no Windows, build SEA e smoke do executável extraído: `--help`, `--doctor` com importação real dos módulos WhatsApp/QR/navegador/PDF/SQLite, primeira execução não interativa e ciclo isolado sem painel/envios. Artefato **VagaRadar-Windows-x64**, **89,7 MB**; digest do artefato publicado `sha256:26720091c8a07b6a6c61eb145a4a801930e4401656256b3a48a44d3d8eaa36cd`. O teste não equivale a pareamento de conta real ou candidatura em produção. O pacote anterior `dd4356b` não contém estas mudanças.

## Limites da validação

Os testes usam dados fictícios, transportes simulados e formulários interceptados. Nenhuma candidatura real foi submetida, nenhum WhatsApp pessoal foi conectado e nenhuma mensagem real ou chamada paga de GPT foi feita nesta instância. O usuário precisa ler o QR localmente e responder ao teste para comprovar a conexão da própria conta.

A consulta pública de vagas, a preparação e os formulários suportados são capacidades distintas. Greenhouse/Ashby e outros sites não ganham envio universal por causa do novo conector Lever. CAPTCHA, login e controles não suportados continuam pendentes para revisão. Os testes de relógio não comprovam doze horas ininterruptas em produção nem funcionamento com o computador desligado.

## Resultados históricos

# Histórico da validação até v2.1

Esta evolução preserva o painel antigo como opção (`npm run web`) e muda o caminho principal (`npm start`) para execução sem interface. Resultados desta sessão:

- `npm test`: **69 passaram**, zero falhas/ignorados/cancelados. Inclui 27 verificações anteriores, pipeline sem servidor, currículo ATS real, GPT opcional, webhook/respostas WhatsApp e submissão Lever com fetch simulado.
- `npm run test:ui`: regressão Chromium desktop/mobile passou, sem mensagens/candidaturas reais.
- CLI `--help`: executado. Ciclo `--once --collect-only` isolado, com coleta pausada: executado e relatório persistido, sem iniciar servidor.
- Coleta real pelo entrypoint sem interface: **266 vagas recebidas e persistidas, zero erros**, em banco temporário isolado removido após validação. Sem perfil/currículo real fornecido, nenhuma preparação ou candidatura pessoal foi realizada nessa coleta.
- Currículos: PDFKit gerou PDFs de verdade e pdf-parse os releu nos testes. Fatos originais preservados, habilidades inexistentes rejeitadas, arquivos privados e versões reproduzíveis por conteúdo.
- Perguntas: teste encadeou pergunta ao WhatsApp falso, resposta assinada/deduplicada, persistência da resposta e retomada de preparação/envio simulado. Não houve mensagem real, pois as credenciais Meta e o destino não estão configurados.
- GPT: contrato Responses API e validação do plano testados com fixtures; zero consumo pago. Nenhuma chave está disponível nesta instância.
- Envio: connector Lever verifica recibo da API; timeout ambíguo persiste e não é repetido após reinício. Testes não autorizam ou comprovam envio real; não há credencial de integração da empresa nesta instância.
- Horário: limites 08h–20h de São Paulo e virada da meia-noite testados com relógio controlado. Não foram executadas doze horas contínuas de produção, nem instalado agendamento no computador do usuário.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilidades relatadas no momento da consulta.
- Windows: **build e smoke reais concluídos com sucesso** no [run 40607731691](https://github.com/emanuellMarinho/bot-linkedin/actions/runs/40607731691), commit `e8df71b`, duração 3m42s. O runner executou instalação pelo lockfile, npm test em Windows, geração SEA, extração do ZIP, `--help` do executável e ciclo isolado com relatório persistido/sem painel. Artefato `VagaRadar-Windows-x64`, 74,4 MB. O pacote é `.exe` mais diretório `app/`, não arquivo único. Esse smoke não comprova operação contínua de doze horas nem integrações externas com credenciais reais.

## Integrações e configuração pendentes

O programa está implementado e testado localmente; operação pessoal ponta a ponta ainda depende de currículo real, dados do candidato, credenciais e infraestrutura externa. WhatsApp precisa de API oficial Business, template aprovado, número permitido e receptor HTTPS com assinatura HMAC. GPT é opcional via chave própria. Envio Lever exige API key autorizada da integração da empresa, não o login de candidato. Outros destinos não possuem envio universal implementado.

Definições técnicas/fontes consultadas: SDK oficial OpenAI `openai/openai-node` (Responses), SDK oficial Meta `WhatsApp/WhatsApp-Nodejs-SDK` (mensagens/webhooks), documentação oficial `lever/postings-api`, documentação Node 24.19 Single Executable Applications. Docs OpenAI/Meta em seus sites estiveram bloqueados e foram consultados pelos repositórios oficiais; endpoints reais de mensagens/GPT/submissões não foram chamados.

As instruções de inicialização e os domínios opcionais foram salvos no rascunho do ambiente, preservando os domínios anteriores. Isso não ativa credenciais, publica hospedagem, disponibiliza webhook HTTPS ou instala um processo de doze horas no computador do usuário. README descreve configuração local; segredos nunca devem ser enviados em chat.

## Assistente de terminal v2.1

O `.exe` agora oferece configuração interativa no primeiro uso, salva dados e chaves no JSON local privado, copia o currículo validado, permite reconfigurar com `--setup` e permanece aberto executando a rotina até Ctrl+C. Node.js foi mantido para reutilizar o runtime Windows já validado e os módulos existentes; não é necessário instalar Node ao usar o pacote portátil completo.

- `npm test`: **77 testes passaram**, incluindo seis novos testes do assistente e dois do wrapper Windows.
- Teste com PTY Linux real: nome/e-mail/currículo/habilidades/número pessoal/GPT configurados com dados fictícios, chave digitada sem eco, JSON persistido, cópia do currículo conferida e inicialização contínua sem `--watch`. Ctrl+C encerrou com código 0. Fontes vazias impediram chamadas externas; nenhuma credencial real foi usada.
- Validação de erro/cancelamento: PDF inválido permite corrigir a entrada; cancelamento não grava configuração parcial; Enter preserva fontes, preferências e chaves anteriores. Chaves não aparecem como padrões nem no histórico readline.
- A API Business permanece opcional. Informar o número pessoal define apenas o destino, não autentica remetente. Não foi criada conexão WhatsApp Web/QR nem enviado login ou mensagem sem autorização.
- Build Windows do primeiro assistente: **sucesso em 3m53s**, incluindo instalação/testes/build/smoke, no workflow [40610371610](https://github.com/emanuellMarinho/bot-linkedin/actions/runs/40610371610), commit `69c2d13`. Os resultados acima de terminal real são Linux; o runner testa o executável Windows extraído em modo sem TTY, sem fingir digitação física no console Windows.

## Preferência por número pessoal sem pareamento

O usuário recusou QR code e cadastro Business no assistente. O fluxo básico foi reduzido a número pessoal; não inicia sessão WhatsApp nem afirma que o canal está conectado. As opções Meta/Lever de operador ficam apenas em `--advanced-setup`, preservando integrações existentes. Sem remetente autenticado, mensagens não são enviadas.

- `npm test`: **79 passaram**, incluindo número pessoal sem prompts Business/QR, carregamento privado de chave GPT e respostas locais validadas sem parar a busca.
- PTY Linux real repetido no fluxo básico: nenhuma pergunta Business/QR, chave sem eco, JSON salvo, execução contínua e Ctrl+C com saída 0. Sem chamadas externas.
- As respostas pelo terminal são persistidas com origem `terminal:` e o bot as consome na próxima verificação, como ocorre com respostas autenticadas vindas do canal externo.


Validação final Windows do fluxo simplificado: **sucesso em 3m59s** no [run 40611122506](https://github.com/emanuellMarinho/bot-linkedin/actions/runs/40611122506), commit `dd4356b`. Instalação, testes Windows, geração SEA e smoke do executável extraído passaram; artefato `VagaRadar-Windows-x64`, 74,4 MB. Em PTY Linux real, a dúvida de e-mail foi exibida, uma resposta inválida rejeitada e a resposta válida persistida enquanto o bot continuava aberto; Ctrl+C encerrou com código0. Nenhuma mensagem externa foi enviada.

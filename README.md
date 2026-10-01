# Tunnel Reverso por WebSocket

Este projeto cria um tunnel reverso para expor serviços HTTP privados por meio
de um VPS, sem abrir portas de entrada na máquina privada.

```text
Cliente HTTP -- HTTPS /tunnel/<serviço> --> relay no VPS -- WSS /agent --> agente privado --> serviço configurado
```

O agente privado inicia a conexão para o VPS. O VPS autentica separadamente o
cliente HTTP e o agente. Cada agente possui uma lista explícita de serviços e
URLs permitidos, portanto o projeto não atua como proxy aberto. Corpos de
requisição, headers relevantes e respostas HTTP em streaming são preservados.

## Estrutura

- `server/`: serviço executado no VPS. Expõe `/tunnel/<serviço>`, `/agent` e
  `/healthz`.
- `agent/`: serviço executado na máquina privada e conectado de saída ao VPS.
- `Dockerfile` e `compose.yaml`: modo Docker para executar o relay no VPS.

## Pré-requisitos

- Node.js 20.6 ou superior nas duas máquinas.
- Um domínio apontando para o VPS, caso o tunnel precise de acesso externo.
- Uma camada HTTPS/TLS já existente no VPS para o endpoint público.

## Instalar dependências

Execute uma vez, na raiz do projeto, tanto no VPS quanto na máquina privada:

```bash
npm install
```

## Configurar o servidor no VPS

Copie `server/.env.example` para `server/.env` e preencha os valores reais.
Gere dois segredos longos e diferentes; por exemplo:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

- `CLIENT_BEARER_TOKEN`: protege os endpoints públicos
  `/tunnel/<serviço>`.
- `AGENT_BEARER_TOKEN`: autentica a conexão WebSocket de saída do agente.
- `TUNNEL_AGENT_ID`: deve ser igual a `AGENT_ID` na máquina privada.

Não versione nem publique o arquivo `server/.env`.

### Executar pelo npm

```bash
npm run server
```

Mantenha a porta interna `8787` privada sempre que possível. Sua infraestrutura
HTTPS existente deve encaminhar o tráfego público para o relay.

### Executar com Docker Compose

O Docker Compose executa somente o relay no VPS. O agente continua sendo
executado com Node.js na máquina privada.

1. Crie e preencha o arquivo de ambiente:

```bash
cp server/.env.example server/.env
```

2. Inicie o container:

```bash
docker compose up -d --build
```

3. Veja estado e logs:

```bash
docker compose ps
docker compose logs -f relay
```

Por padrão, o Compose publica `127.0.0.1:8787` no VPS. Caso sua infraestrutura
de rede exija outro bind ou porta, defina as variáveis antes de iniciar:

```bash
RELAY_BIND_ADDRESS=0.0.0.0 RELAY_HOST_PORT=8787 docker compose up -d
```

A imagem executa como usuário não-root, usa filesystem somente leitura e tem
reinício automático. O modo `npm run server` continua disponível mesmo com
Docker configurado.

## Configurar o agente privado

Copie `agent/.env.example` para `agent/.env` e preencha, por exemplo:

```dotenv
RELAY_URL=https://tunnel.exemplo.com
AGENT_ID=minha-maquina
AGENT_BEARER_TOKEN=mesmo-token-do-agente-no-VPS
SERVICES_JSON='{"meu-servico":"http://127.0.0.1:3000"}'
```

`SERVICES_JSON` é uma lista de permissões: cada nome só pode encaminhar para a
URL configurada. Não inclua serviços que o agente não deve expor.

Inicie o agente:

```powershell
npm run agent
```

Ele deverá informar o ID registrado e os serviços disponíveis. O agente tenta
reconectar automaticamente se a conexão WebSocket cair.

## Usar um serviço configurado

Cada serviço permitido pelo agente fica disponível neste endereço:

```text
https://tunnel.exemplo.com/tunnel/<nome-do-serviço>
```

O cliente deve enviar o header abaixo, usando o valor de
`CLIENT_BEARER_TOKEN`:

```text
Authorization: Bearer <token>
```

Enquanto o agente estiver offline, o relay responde com HTTP `503`.

## Notas operacionais

- A primeira versão suporta um agente identificado por `TUNNEL_AGENT_ID`.
- Adicione vários agentes e regras de roteamento apenas depois de validar o
  fluxo básico.
- Nunca versione arquivos `.env`, tokens ou domínios privados em repositórios
  públicos.
- Depois do teste manual, use um gerenciador de processos no VPS e o Agendador
  de Tarefas do Windows para manter o agente ativo.

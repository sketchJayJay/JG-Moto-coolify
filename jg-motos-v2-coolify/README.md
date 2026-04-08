# JG MOTOS V2 • Coolify Stack

Sistema web completo para oficina / loja de motos, pronto para subir no **Coolify** como **Docker Compose**.

## O que vem nesta V2

- Login com JWT
- API Node.js + Express
- Banco PostgreSQL
- Frontend responsivo para celular e computador
- Cadastro de clientes
- Cadastro de motos
- Estoque
- Orçamentos com itens
- Conversão de orçamento em OS
- Ordens de serviço
- Vendas de balcão com baixa automática do estoque
- Recibos
- Financeiro
- Fila fiscal interna para futura integração com NF-e / NFS-e
- Exportação e restauração de backup em JSON
- Dados demo para teste

## Credenciais iniciais

- **E-mail:** `admin@jgmotos.local`
- **Senha:** `123456`

Troque isso depois do primeiro deploy.

## Estrutura

```text
/docker-compose.yml
/.env.example
/services/api
/services/web
```

## Deploy no Coolify

1. Suba esta pasta para um repositório Git.
2. No Coolify, crie uma nova aplicação usando o build pack **Docker Compose**. O Coolify documenta esse fluxo e permite escolher **Base Directory** e o caminho do arquivo compose. citeturn742525search9turn742525search15
3. Use **Base Directory** = `/` e **Docker Compose Location** = `docker-compose.yml` se os arquivos estiverem na raiz. citeturn742525search9
4. Crie as variáveis de ambiente com base no arquivo `.env.example`. O Coolify mostra variáveis obrigatórias no compose usando a sintaxe `${VAR:?}`. citeturn742525search1turn742525search5
5. Exponha o serviço **web** com domínio no Coolify. Domínios entram nas aplicações, não nos bancos. citeturn742525search10
6. Mantenha o volume do Postgres persistente. O Coolify suporta volumes/bind mounts para preservar dados entre deploys. citeturn742525search3
7. Health checks podem ficar no Docker Compose, e o Coolify recomenda habilitá-los para que só serviços saudáveis recebam tráfego. citeturn742525search6

## Deploy local com Docker Compose

```bash
a. cp .env.example .env
b. edite as senhas no arquivo .env
c. docker compose up -d --build
```

Depois abra:

```text
http://localhost
```

## Sobre a emissão fiscal

Esta V2 já deixa uma **fila fiscal interna** e a base de dados pronta para o próximo passo. A emissão oficial de **NF-e / NFC-e / NFS-e** ainda depende de integração fiscal, certificado digital e regras locais.

## Observação prática

A API cria o esquema do banco automaticamente na primeira inicialização e também cria o usuário administrador inicial.

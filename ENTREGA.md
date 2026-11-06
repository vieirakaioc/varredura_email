# Entrega do Validador Fiscal

Documento para quem assume a operação do sistema. Escrito para alguém que **não** acompanhou a
construção: siga na ordem.

---

## 1. O que precisa mudar de dono antes de qualquer coisa

O sistema hoje depende de quatro coisas que estão numa conta pessoal. Enquanto não mudarem, ele
para de funcionar quando essa pessoa sair.

| Dependência | Situação hoje | O que fazer |
|---|---|---|
| Repositório no GitHub | `github.com/vieirakaioc/varredura_email` (conta pessoal) | Transferir para uma organização da empresa, ou criar repositório da empresa e enviar o código para lá |
| Rede Tailscale | tailnet da conta pessoal `vieirakaioc@` | Criar tailnet da empresa e refazer o acesso, ou usar a rede interna |
| Máquina que roda o sistema | computador pessoal de trabalho, tarefa disparada **no logon** | Mover para um servidor ou outro PC, com a tarefa disparando **na inicialização** |
| Segredos (`.env`) | só existem nessa máquina | Copiar para a máquina nova e guardar num cofre de senhas da empresa |

**Nada disso está no Git, de propósito.** Tem que ser copiado à mão.

---

## 2. O que NÃO está no repositório e precisa ser copiado

Copie estes itens da máquina atual para a nova, por pendrive ou pasta de rede — **nunca por
e-mail ou WhatsApp**:

```
.env                  credenciais do Senior, do Zoho e o segredo da aplicação
data/                 banco (validador.db), certificados digitais A1 e anexos
```

A pasta `data/` contém os **certificados A1 das empresas, com as senhas guardadas**. Trate como
documento sigiloso.

> Antes de copiar, **pare o sistema** (veja a seção 5) para o banco não ser copiado no meio de uma
> escrita.

---

## 3. Instalar numa máquina nova

Requisitos: **Windows**, **Node.js 22.13 ou mais novo** (hoje roda no 24), **Git**.

```powershell
# 1. baixar o código
git clone <endereço-do-repositório> C:\validador
cd C:\validador

# 2. copiar os arquivos que não vêm do Git
#    (cole aqui o .env e a pasta data\ trazidos da máquina antiga)

# 3. instalar as dependências e compilar a tela
npm install
npm run build --workspace web

# 4. instalar a tarefa que mantém o sistema no ar
powershell -ExecutionPolicy Bypass -File .\scripts\instalar-tarefa.ps1 -AoIniciar
```

O parâmetro `-AoIniciar` faz a tarefa subir **quando o computador liga**, sem depender de alguém
fazer login. É o que garante que o sistema continue no ar sozinho. Sem ele, a tarefa só roda
depois que um usuário entra no Windows.

Confira se subiu:

```powershell
Invoke-WebRequest http://localhost:3000/ -UseBasicParsing | Select-Object StatusCode
```

Deve responder **200**.

---

## 4. Dar acesso para as outras pessoas

O sistema escuta em **todos os endereços da máquina, na porta 3000**. Quem está na mesma rede
acessa pelo IP da máquina, por exemplo `http://192.168.27.95:3000`.

Para quem está em outra cidade, há dois caminhos:

**Pela rede da empresa (VPN ou link entre filiais).** Não exige nada do sistema: basta a rede
rotear até a máquina.

**Pelo Tailscale.** Instale o Tailscale na máquina do sistema e na de cada pessoa, todas na mesma
rede (tailnet) **da empresa**. O endereço passa a ser o IP Tailscale da máquina, por exemplo
`http://100.107.142.126:3000`. Nada fica exposto na internet.

> Existe ainda o Tailscale **Funnel**, que publica na internet pública. Hoje ele publica outros
> dois painéis desta máquina, não o Validador. **Não recomendamos** usá-lo para este sistema: ele
> trata dados fiscais e certificados digitais.

---

## 5. Rotina de operação

**Atualizar para a versão nova do código:**

```powershell
cd C:\validador
powershell -ExecutionPolicy Bypass -File .\scripts\atualizar.ps1
```

O script faz backup da pasta `data`, baixa o código, instala dependências, compila e reinicia.
Se houver arquivo alterado na máquina, ele **guarda de lado com `git stash` e segue** — confira a
mensagem em amarelo quando aparecer.

**Reiniciar sem atualizar:** encerre o processo `node`; a tarefa agendada sobe de novo sozinha.

```powershell
Stop-Process -Name node -Force
```

**Backup:** a pasta `data/` é tudo que importa. O `atualizar.ps1` já cria `data_backup_<data>` a
cada execução. Leve uma cópia para fora da máquina pelo menos uma vez por semana.

**Logs:** `data\logs\servidor.log`.

---

## 6. Quando algo não abre

| Sintoma | Primeira coisa a olhar |
|---|---|
| Ninguém acessa | A tarefa está rodando? `Get-ScheduledTask -TaskName "Validador Fiscal"` |
| Só quem está fora acessa mal | A máquina mudou de IP? Confira com `ipconfig` |
| Telas sem dados do Senior | Credenciais do Senior no `.env` e rede até o `SERVERBD` |
| Certificado recusado na SEFAZ | Validade do A1 na tela **SEFAZ**; os certificados vencem todo ano |
| Erro ao importar planilha | A mensagem na tela diz o motivo real (coluna faltando, arquivo errado) |

---

## 7. O que o sistema faz, em uma página

- Lê as caixas de e-mail de suprimentos, identifica NF-e, CT-e, NFS-e e boletos nos anexos
- Confere as notas contra o **Senior** (somente leitura) e contra a **SEFAZ** (certificado A1)
- **Pendentes de lançamento**: o que chegou e ainda não virou nota de entrada
- **Carteira de notas**: a programação diária por pessoa, prioridade e prazo
- **Malha fina**: concilia a planilha do BPO (serviços tomados e EFD) com o que está lançado
- **Produtividade**: quanto o time lançou, por pessoa, tipo de nota e empresa

O sistema **nunca escreve no Senior**. Toda a integração é de leitura.

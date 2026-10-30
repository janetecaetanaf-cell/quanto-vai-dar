# Quanto Vai Dar?

App de celular para somar as compras do supermercado antes de chegar ao caixa.

## O que ele faz

- **Fotografar etiqueta**: tira foto da etiqueta de preço e o app lê o nome e o preço sozinho. Sempre confira antes de adicionar.
- **Digitar**: para quando a foto não der certo.
- **Quantidade**: botões − e + em cada produto. Para frutas, carnes e outros produtos vendidos por peso, escolha **Quilo** e digite o peso da balança.
- **Total em reais (R$)** sempre visível no topo.
- **Limite de gastos**: avisa ao chegar em 80% e quando passar do limite.
- **Histórico**: ao tocar em **Finalizar compra**, a compra fica salva. Dá para buscar quanto você pagou em cada produto.
- **Aviso de preço**: se um produto estiver mais caro do que na última compra, o app avisa (por exemplo: "Leite está R$ 0,50 mais caro que em 30/10").

As compras ficam guardadas **só no celular**. Se você apagar os dados do navegador ou desinstalar o app, o histórico se perde. Por isso existe o **backup** (veja abaixo).

## Backup

Fica no fim da aba **Histórico**.

- **Salvar backup**: cria um arquivo `quanto-vai-dar-backup-AAAA-MM-DD.txt`. No celular, abre a tela de compartilhar: mande para você mesma no WhatsApp, por e-mail ou salve no Google Drive.
- **Restaurar backup**: escolha esse arquivo. As compras do backup são juntadas às que já estão no celular, sem apagar nada e sem duplicar.
- Se você tiver 3 compras ou mais e passar um mês sem salvar backup, o aviso fica vermelho.

### Trocar o app de endereço (por exemplo, para um domínio próprio)

1. No endereço antigo: **Histórico → Salvar backup**.
2. Abra o endereço novo e instale o app de novo na tela inicial.
3. No app novo: **Histórico → Restaurar backup** e escolha o arquivo.
4. Pode apagar o ícone antigo da tela inicial.

## Testar no computador

```
node server.js
```

Depois abra http://localhost:8080 no navegador.

## Testar no celular (mesma rede Wi-Fi)

1. No computador, rode `node server.js`. Ele mostra um endereço como `http://192.168.0.10:8080`.
2. No celular, conectado ao mesmo Wi-Fi, abra esse endereço no Chrome ou no Safari.
3. Se não abrir, o Firewall do Windows pode estar bloqueando: permita o Node.js na rede privada.

Assim já dá para testar tudo, inclusive a câmera. Só que o app só funciona enquanto o computador estiver ligado com o servidor rodando.

## Usar de verdade no mercado (instalar no celular)

Para usar sem o computador, o app precisa estar publicado em um endereço com `https`. Duas opções gratuitas:

- **Netlify Drop** (mais simples, recomendado para validar): crie uma conta gratuita em netlify.com, abra app.netlify.com/drop e arraste a pasta `D:\app` para a página. O endereço sai com nome aleatório; em **Site configuration → Change site name** dá para trocar para algo como `quanto-vai-dar.netlify.app`. Para atualizar depois, arraste a pasta de novo em **Deploys**.
- **GitHub Pages**: crie um repositório no GitHub com estes arquivos e ative o Pages nas configurações.

Quando quiser um domínio próprio, siga o passo a passo de **Trocar o app de endereço**, acima.

Depois, no celular, abra o endereço publicado e:

- **Android (Chrome)**: toque em **Instalar app** no topo do app, ou no menu ⋮ → **Adicionar à tela inicial**.
- **iPhone (Safari)**: toque em **Compartilhar** → **Adicionar à Tela de Início**.

Pronto: o ícone amarelo **R$?** aparece na tela do celular e o app abre mesmo sem internet. A leitura de etiquetas precisa de internet só na primeira foto, para baixar o leitor (cerca de 5 MB).

## Limites da leitura de etiqueta

A leitura é feita no próprio celular, sem enviar a foto para lugar nenhum. Ela funciona melhor com:

- a etiqueta reta, ocupando boa parte da foto, sem reflexo;
- boa luz.

Etiquetas com os centavos pequenos e colados no número, sem vírgula, às vezes não são lidas. Nesse caso, o app avisa e você digita o preço.

## Arquivos

| Arquivo | Para que serve |
| --- | --- |
| `index.html` | As telas do app |
| `styles.css` | Visual (cores, letras, modo escuro) |
| `app.js` | Carrinho, limite, histórico e avisos de preço |
| `ocr.js` | Leitura da foto da etiqueta |
| `sw.js` | Faz o app abrir sem internet |
| `manifest.webmanifest` e `icons/` | Nome e ícone quando instalado no celular |
| `server.js` | Servidor para testar no computador e no Wi-Fi de casa |

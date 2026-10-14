# Creative Desk

Creative Desk é um protótipo local para desenhar em 2D, compor cenas 3D e trabalhar com o Codex da sessão ChatGPT já existente neste Mac.

Abra `/Applications/Creative Desk.app`. A aplicação guarda projetos e cópias dos recursos em `~/CreativeDesk`. Não precisa do login ArtCraft. O Codex precisa da sessão ChatGPT disponível através do seu app-server e de acesso à rede; os editores e o armazenamento funcionam localmente.

## Usar a aplicação

1. Crie uma tela 2D ou uma cena 3D na lista à esquerda.
2. Dê um nome ao projeto. Use as ferramentas do editor para desenhar, colocar objetos, ajustar câmaras ou editar a timeline.
3. Importe imagens, áudio, vídeo ou um modelo GLB. Imagens podem entrar na tela ou substituir a base. GLB pode entrar numa cena. Áudio e vídeo têm pré-visualização com reprodução.
4. Clique em **Guardar**. O estado "Guardado neste Mac" confirma a escrita. Abrir outro projeto guarda primeiro o projeto atual; se a escrita falhar, a aplicação permanece no editor e mostra o erro.
5. No painel Codex, escolha um modelo disponível e escreva um pedido. **Conversar** devolve a resposta real. **Gerar imagem** importa as imagens devolvidas pelo Codex para a biblioteca local. Pode escolher imagens como referências e usar uma imagem gerada como base da tela.

Os ficheiros originais permanecem no seu local. Os recursos importados passam a ter uma cópia em `~/CreativeDesk/assets`. Cada projeto tem o seu JSON e diretório de trabalho Codex em `~/CreativeDesk/projects`.

## Limites deste protótipo

- GLB deve conter os seus buffers e imagens. Referências externas ou relativas são rejeitadas. Algumas extensões ou compressões podem não funcionar no motor existente.
- Áudio e vídeo são pré-visualizações. Não há montagem audiovisual, geração de vídeo ou análise desses ficheiros pelo Codex.
- A interface principal está em português; algumas ferramentas herdadas dos editores estão em inglês.
- O Codex depende dos modelos, capacidades e limites da conta. A aplicação mostra falhas reais e não substitui um pedido falhado por conteúdo simulado.
- O pacote atual destina-se a macOS Intel x86_64. Tem assinatura local ad-hoc; não é uma distribuição notarizada ou uma release publicada.

## Construir e verificar

Feche a aplicação antes de reconstruir ou instalar o pacote. Na raiz do repositório, com as dependências já existentes e Rust/Node instalados:

```sh
script/creative-desk/build-macos.sh --install
```

O script compila o frontend e o executável com `custom-protocol`, inclui o frontend no executável, monta e assina `target/creative-desk-macos/Creative Desk.app` e instala em `/Applications`. Se essa pasta não for gravável, usa `~/Applications`. Não instala dependências. Recusa substituir um bundle com outro identificador ou com symlinks. Não altera credenciais nem dados anteriores.

Para verificar o editor real num navegador, mantenha o servidor local aberto num terminal:

```sh
cd frontend
./node_modules/.bin/vite --config apps/creative-desk/vite.config.ts
```

Noutro terminal, na raiz:

```sh
node script/creative-desk/verify.mjs
cd frontend
node apps/creative-desk/save-navigation.browser.mjs
```

O teste usa Playwright já instalado e o Google Chrome local, sem downloads. `CREATIVE_DESK_TEST_IMAGE` permite indicar um PNG local; por omissão usa um PNG mínimo. Os testes rejeitam pedidos externos e injetam apenas o transporte de armazenamento na versão de desenvolvimento. A aplicação distribuída usa o transporte Tauri real. O teste gera áudio/vídeo sintéticos com o `ffmpeg` local em `/usr/local/bin/ffmpeg` e guarda capturas e resultados numa pasta temporária `creative-desk-verify-*`.

O pacote inclui as licenças MIT e Apache, o NOTICE do projeto, a licença Three.js, o aviso zlib do recurso Ammo e o aviso da fonte Helvetiker em `Contents/Resources/Licenses`. Creative Desk modifica e reutiliza os editores do Artcraft; não é a aplicação oficial ArtCraft.

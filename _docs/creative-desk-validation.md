# Validação do Creative Desk

A validação distingue o navegador de desenvolvimento, que usa armazenamento de teste, da aplicação instalada, que usa o armazenamento nativo e o Codex real.

## Verificações reproduzíveis

Na raiz:

```sh
cargo test -p creative_desk --no-default-features
script/creative-desk/build-macos.sh --install
```

Na pasta `frontend`:

```sh
./node_modules/.bin/vitest run --config apps/creative-desk/vite.config.ts
node apps/creative-desk/save-navigation.browser.mjs
```

Com o servidor Vite em `127.0.0.1:1421`, na raiz:

```sh
node script/creative-desk/verify.mjs
```

O teste de navegador usa o App e os motores de desenho/3D reais. Verifica importação PNG/GLB, guardar/reabrir, isolamento entre dois projetos, alterações durante uma escrita pendente, câmaras/timeline, reprodução de áudio/vídeo e erro de formato não suportado. Regista erros JavaScript e rejeita todos os pedidos fora da origem local. As quatro regressões de guardar e navegar verificam espaços iniciais e finais, renomeação concorrente e alterações de conteúdo e ordem dos objetos durante uma escrita pendente. O armazenamento de teste ordena as propriedades JSON como o backend nativo.

O executável instalado permite uma verificação adicional de armazenamento numa pasta temporária nova:

```sh
CHECK_ROOT="$(mktemp -d /tmp/creative-desk-storage.XXXXXX)"
"/Applications/Creative Desk.app/Contents/MacOS/creative_desk" --smoke-test "$CHECK_ROOT"
```

A opção `--codex-smoke --codex-model gpt-6-luna` acrescenta um pedido real ao Codex e consome a quota da conta. Só a execute quando quiser repetir essa verificação. Não é necessária para os testes locais do editor.

## Limites das verificações

A compilação Vite tem avisos herdados de `react-virtualized` e do tamanho dos módulos. A verificação TypeScript completa tem 38 diagnósticos em fontes partilhadas existentes, incluindo declarações de JavaScript ausentes e bindings não utilizados. Os testes específicos e a compilação têm resultados próprios; não se afirma que todo o monorepo passa a verificação de tipos.

A geração de imagem real foi verificada uma vez com o backend revisto e configuração de ferramentas restrita. O Codex devolveu um PNG de 1254 × 1254 que foi descodificado e usado como recurso na verificação local. Os testes de navegador não simulam uma geração bem sucedida nem repetem inferência.

## Resultados da aplicação instalada

Validação concluída em 14 de outubro de 2026, com a correção de comparação JSON do commit `124315e` incorporada no executável.

- 17 testes Rust passaram. O backend não mudou desde essa execução.
- 19 testes frontend e quatro regressões reais de guardar e navegar passaram após a correção. O teste completo dos motores também passou com armazenamento que ordena propriedades JSON.
- Vite e `cargo build -p creative_desk --release --features custom-protocol` passaram. O pacote instalado é Mach-O x86_64 e a assinatura ad-hoc passa `codesign --verify --deep --strict`.
- O executável instalado passou a escrita e leitura de armazenamento numa pasta temporária nova.
- Na janela nativa, **Guardar** termina em "Guardado neste Mac". O ficheiro deixa de receber escritas quando não há alterações.
- A sessão ChatGPT e o catálogo real carregaram. Um pedido por **Conversar**, com GPT-6-Luna, devolveu "Creative Desk ready." e terminou normalmente.
- O seletor de ficheiros nativo importou o PNG existente. A pré-visualização e a tela mostraram os seus píxeis. A cópia em `~/CreativeDesk/assets` coincide com o original e o projeto incorpora a camada de imagem.
- A cena nativa criou, mostrou e guardou um cubo. Após fechar a aplicação e abrir um processo novo, a cena voltou a mostrar o cubo e a tela voltou a mostrar a imagem. Os projetos anteriores permaneceram no disco.

A primeira verificação nativa encontrou escritas repetidas porque o frontend comparava a ordem textual das propriedades JSON. Essa falha foi corrigida. A comparação atual ignora essa ordem, preserva os valores e a ordem dos arrays, e mantém as barreiras para alterações concorrentes.

Câmaras, keyframes, GLB e reprodução WAV/MP4 têm cobertura no navegador com os motores reais. A inspeção nativa desta execução cobriu a imagem, o cubo, o armazenamento, o reinício e o Codex. Não repetiu geração de imagem nem verificou todos os codecs ou extensões GLB. A assinatura local não substitui notarização ou testes noutros Macs.

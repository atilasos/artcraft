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
./node_modules/.bin/vitest run --config "$PWD/apps/creative-desk/vite.config.ts" --root "$PWD/libs/components/pagescene" --globals src/lib/engine/scene.spec.ts src/lib/proxy/storyteller_proxy_scene.spec.ts
```

Com o servidor Vite em `127.0.0.1:1421`, na raiz:

```sh
node script/creative-desk/verify.mjs
```

O teste de navegador usa o App e os motores de desenho/3D reais. Verifica importação PNG/GLB, guardar/reabrir, isolamento entre dois projetos, alterações durante uma escrita pendente, câmaras/timeline, reprodução de áudio/vídeo e erro de formato não suportado. Regista erros JavaScript e rejeita todos os pedidos fora da origem local. As sete regressões do App verificam espaços iniciais e finais, renomeação concorrente, alterações de conteúdo e ordem dos objetos durante uma escrita pendente, keyframes da câmara, capturas e seleção repetida do projeto ativo. O teste da câmara verifica a animação após reabrir e a retenção dos keyframes na gravação seguinte. O teste de captura verifica a entrada imediata na biblioteca, os píxeis da pré-visualização e a conservação da mesma instância do editor. O armazenamento de teste ordena as propriedades JSON como o backend nativo.

O executável instalado permite uma verificação adicional de armazenamento numa pasta temporária nova:

```sh
CHECK_ROOT="$(mktemp -d /tmp/creative-desk-storage.XXXXXX)"
"/Applications/Creative Desk.app/Contents/MacOS/creative_desk" --smoke-test "$CHECK_ROOT"
```

A opção `--codex-smoke --codex-model gpt-6-luna` acrescenta um pedido real ao Codex e consome a quota da conta. Só a execute quando quiser repetir essa verificação. Não é necessária para os testes locais do editor.

## Limites das verificações

A compilação Vite tem avisos herdados de `react-virtualized` e do tamanho dos módulos. A verificação TypeScript completa tem 38 diagnósticos em fontes partilhadas existentes, incluindo declarações de JavaScript ausentes e bindings não utilizados. Os testes específicos e a compilação têm resultados próprios; não se afirma que todo o monorepo passa a verificação de tipos.

A verificação de tipos foi repetida no commit `0c6b462`: terminou com 38 diagnósticos partilhados e nenhum em `apps/creative-desk`. Para reproduzir, na pasta `frontend`:

```sh
./node_modules/.bin/tsc --project apps/creative-desk/tsconfig.json --noEmit
```

A geração de imagem real foi verificada uma vez com o backend revisto e configuração de ferramentas restrita. O Codex devolveu um PNG de 1254 × 1254 que foi descodificado e usado como recurso na verificação local. Os testes de navegador não simulam uma geração bem sucedida nem repetem inferência.

## Resultados da aplicação instalada

Verificações realizadas em 14 e 15 de outubro de 2026. A primeira compilação incorporou a correção de comparação JSON do commit `124315e`. As correções seguintes estão identificadas abaixo.

- 17 testes Rust passaram. O backend não mudou desde essa execução.
- 20 testes frontend, dez testes dos componentes Scene e proxy, e sete regressões reais do App passaram após as correções. O teste completo dos motores também passou com armazenamento que ordena propriedades JSON.
- Vite e `cargo build -p creative_desk --release --features custom-protocol` passaram. O pacote instalado é Mach-O x86_64 e a assinatura ad-hoc passa `codesign --verify --deep --strict`.
- O executável instalado passou a escrita e leitura de armazenamento numa pasta temporária nova.
- Na janela nativa, **Guardar** termina em "Guardado neste Mac". O ficheiro deixa de receber escritas quando não há alterações.
- A sessão ChatGPT e o catálogo real carregaram. Um pedido por **Conversar**, com GPT-6-Luna, devolveu "Creative Desk ready." e terminou normalmente.
- O seletor de ficheiros nativo importou o PNG existente. A pré-visualização e a tela mostraram os seus píxeis. A cópia em `~/CreativeDesk/assets` coincide com o original e o projeto incorpora a camada de imagem.
- A cena nativa criou, mostrou e guardou um cubo. Após fechar a aplicação e abrir um processo novo, a cena voltou a mostrar o cubo e a tela voltou a mostrar a imagem. Os projetos anteriores permaneceram no disco.

A primeira verificação nativa encontrou escritas repetidas porque o frontend comparava a ordem textual das propriedades JSON. Essa falha foi corrigida. A comparação atual ignora essa ordem, preserva os valores e a ordem dos arrays, e mantém as barreiras para alterações concorrentes.

Câmaras, keyframes, GLB e reprodução WAV/MP4 têm cobertura no navegador com os motores reais. A inspeção nativa desta execução cobriu a imagem, o cubo, o armazenamento, o reinício e o Codex. Não repetiu geração de imagem nem verificou todos os codecs ou extensões GLB. A assinatura local não substitui notarização ou testes noutros Macs.

## Substituição de pacotes sem recursos antigos

A construção e a instalação usam pacotes novos em pastas temporárias do mesmo volume do destino. O script assina e verifica o pacote antes de o colocar no destino. Um pacote anterior com identificador `local.creative.desk`, sem symlinks, fica inteiro numa pasta `.creative-desk-backup.*` ao lado. Recursos que já não pertencem à versão atual não passam para o pacote novo. Não há limpeza automática das cópias ou das pastas temporárias.

A regressão de substituição verifica um recurso e um helper antigos: ambos desaparecem do pacote atual e permanecem na cópia preservada. Destinos com outro identificador, symlinks no próprio destino ou symlinks internos são recusados sem alteração. A construção e a instalação reais também foram verificadas com recursos sentinela nos pacotes anteriores, além da assinatura e arquitetura. A primeira reabertura sem servidor de desenvolvimento mostrou um bloqueio do editor 3D. A imagem dos objetos continuava visível, mas os controlos estavam desativados e Guardar devolvia "A cena ainda está a abrir". A investigação posterior reproduziu a perda do editor ao selecionar novamente o projeto ativo, descrita abaixo. Não foi repetida inferência nesta verificação do pacote.

## Correções da revisão final

O commit `d1c0265` conserva a identidade da câmara renderizada no documento. Os keyframes voltam a encontrar a câmara após reabrir e permanecem na gravação seguinte. O teste executa a animação real nas posições x=0 e x=4 e verifica também cenas antigas sem o novo campo.

O commit `83bb9e8` atualiza a biblioteca e a pré-visualização quando uma captura termina. O teste usa a captura real do motor e confirma que o editor e o cubo continuam ativos. Ambas as regressões falharam antes da respetiva correção e passaram depois. A revisão independente aprovou as duas alterações.

## Seleção repetida do projeto ativo

A navegação tentava encerrar e recriar o editor mesmo quando o projeto selecionado já estava aberto. Se a atualização React para fechar a cena não concluísse antes do reset das referências, a tela podia permanecer montada e perder o editor. O último fotograma continuava visível, sem controlos nem possibilidade de guardar.

Um teste do App real reproduziu a falha com transporte assíncrono de armazenamento e o callback de navegação antecipado. Antes da correção, a tela mantinha a identidade, mas o editor desaparecia e a cena deixava de estar pronta. O commit `0c6b462` faz a seleção do projeto ativo terminar antes de guardar, limpar referências ou iniciar outro carregamento. O teste passou a conservar o editor, a tela, o nome editado e os dois cubos, e confirmou a gravação posterior. Não foi necessário alterar o motor partilhado nem forçar flags de prontidão.

## Reabertura nativa após a correção

A compilação final incorpora o código `0c6b462`, sem instrumentação de diagnóstico. Vite e a compilação Rust de release passaram. O executável instalado é x86_64 e a assinatura local passou a verificação estrita.

Foram testados quatro processos novos de `/Applications/Creative Desk.app`, sempre sem servidor na porta 1421. Nos três primeiros, a aplicação abriu a tela existente e a cena, manteve os controlos ativos após três seleções repetidas, acrescentou uma forma e concluiu Guardar. Cada processo seguinte reabriu exatamente o documento escrito pelo anterior, com a mesma identidade da câmara. O quarto processo recuperou a última gravação e manteve os cinco objetos e a câmara após mais três seleções, sem alterar o documento. A aplicação final ficou aberta.

A suite completa do navegador também foi repetida após a correção: os cinco grupos passaram, sem erros de página ou consola e sem pedidos externos. As sete regressões do App e os 20 testes frontend passaram no mesmo código. O backend e os dez testes Scene/proxy já validados não foram alterados por esta última correção. A geração de imagem e o pedido real ao Codex anteriormente verificados não foram repetidos.

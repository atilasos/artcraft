# Avaliação do ArtCraft e proposta de adoção das apps criativas

Avaliação inicial em 12 de outubro de 2026. O objetivo é escolher ferramentas para trabalho criativo no Mac e decidir onde vale a pena personalizar o código.

A prioridade passou a ser trabalhar sem conta nem serviços alojados do ArtCraft, usando fornecedores diretos e, quando suportado, a conta do Codex neste computador. O utilizador aprovou o desenho abaixo e autorizou criar o fork, implementar o primeiro protótipo, compilar e testar no Mac. Em 13 de outubro pediu primeiro uma pesquisa dos forks existentes para reduzir trabalho. A [comparação de forks](/Users/igor/Documents/artcraft/_docs/forks-2026-10-13.md) recomenda conservar a base atual e aproveitar alterações pertinentes do NRS Craft; nenhum candidato examinado cumpre todos os requisitos. O fork do desktop não altera as apps criativas, que têm repositórios próprios.

O utilizador confirmou um perfil multidisciplinar, com uso frequente mas variável destas áreas. O conjunto inicial proposto é ArtCraft Launcher, PhotoCraft, VectorCraft, FilmCraft, EffectCraft e SoundCraft. Blender já está instalado. O ArtCraft oficial foi removido a pedido do utilizador. LightCraft fica como complemento se houver trabalho com bibliotecas fotográficas e RAW.

## Organização dos projetos

O [ArtCraft principal](https://github.com/storytold/artcraft) é um estúdio para geração com IA e composição 2D/3D. O [ArtCraft Launcher](https://github.com/storytold/craft-launcher) instala e atualiza as Crafting Apps. As [doze apps do catálogo](https://getartcraft.com/apps) são projetos separados para edição de imagem, vetores, fotografia, vídeo, efeitos, paginação, áudio, PDFs, apresentações, texto, CAD e folhas de cálculo.

Assim, uma alteração ao PhotoCraft pertence ao repositório `storytold/photocraft`; uma alteração ao FilmCraft pertence a `storytold/filmcraft`. O Launcher pode continuar oficial enquanto usamos versões oficiais das apps.

## Situação neste Mac

O computador tem processador Intel Core i7-9750H, 16 GiB de RAM e macOS 26.6.2. A aplicação oficial instalada era ArtCraft 0.41.0, universal, com assinatura aceite pelo Gatekeeper. A pedido do utilizador, foi fechada e movida para `/Users/igor/.Trash/ArtCraft-removido-2026-10-12.app`. Foi confirmada a ausência de `/Applications/ArtCraft.app`; projetos, credenciais e outros dados locais não foram alterados.

Também existem Blender 4.5.13 e Blender 5.2.1 Intel. Estas instalações permitem manter uma ferramenta de 3D enquanto avaliamos o ecossistema ArtCraft.

A [última release oficial do ArtCraft](https://github.com/storytold/artcraft/releases/tag/artcraft-v0.41.0) corresponde à versão que foi removida. O [Launcher atual é 0.3.2](https://github.com/storytold/craft-launcher/releases/tag/v0.3.2), com DMG universal. O site ainda apontava para Launcher 0.2.1 em algumas páginas, pelo que devemos obter a versão pela página oficial de releases. O [README do Launcher](https://github.com/storytold/craft-launcher/blob/v0.3.2/README.md) declara suporte a macOS 11 ou superior.

## Apps a considerar para trabalho criativo

Estas versões e estados correspondem às releases consultadas. A seleção cobre as áreas confirmadas pelo utilizador; os formatos e projetos concretos do piloto ainda precisam de ser escolhidos.

| App          | Utilização                         | Release | Estado      | Prioridade proposta                        |
| ------------ | ---------------------------------- | ------- | ----------- | ------------------------------------------ |
| PhotoCraft   | Imagem, camadas, máscaras e PSD     | 0.7.0   | Early alpha | Conjunto inicial para experimentar         |
| VectorCraft  | Ilustração e desenho vetorial       | 0.9.0   | Alpha       | Conjunto inicial para experimentar         |
| LightCraft   | Catálogo fotográfico e edição RAW   | 0.6.0   | Alpha       | Complemento para fotografia e RAW          |
| FilmCraft    | Montagem e exportação de vídeo      | 0.6.0   | Alpha       | Conjunto inicial para experimentar         |
| EffectCraft  | Animação gráfica e efeitos visuais  | 0.8.0   | Alpha       | Conjunto inicial para experimentar         |
| DesignCraft  | Paginação e publicação              | 0.6.0   | Pre-alpha   | Experimentar quando houver necessidade     |
| SoundCraft   | Gravação, edição e mistura de áudio | 0.5.0   | Pre-alpha   | Conjunto inicial com validação de áudio     |

Fontes de versões e maturidade: [PhotoCraft](https://github.com/storytold/photocraft/blob/v0.7.0/README.md), [VectorCraft](https://github.com/storytold/vectorcraft/blob/v0.9.0/README.md), [LightCraft](https://github.com/storytold/lightcraft/blob/v0.6.0/README.md), [FilmCraft](https://github.com/storytold/filmcraft/blob/v0.6.0/README.md), [EffectCraft](https://github.com/storytold/effectcraft/blob/v0.8.0/ROADMAP.md), [DesignCraft](https://github.com/storytold/designcraft/blob/v0.6.0/README.md) e [SoundCraft](https://github.com/storytold/soundcraft/blob/v0.5.0/README.md).

PdfCraft e DeckCraft podem complementar o trabalho com PDFs e apresentações. WordCraft, CADCraft e GridCraft podem ser escolhidos quando esses usos forem relevantes. Não é necessário instalar a suite inteira para começar.

Há limitações concretas que devem orientar o piloto. O PhotoCraft ainda não é apresentado pelos autores como substituto do Photoshop para trabalho profissional diário. O FilmCraft não abre `.prproj` e não aloja VST3, Audio Units ou OpenFX. O LightCraft tem diferenças no suporte RAW e na calibração de cor de câmaras. A presença de menus ou grandes catálogos de comandos não garante que o nosso projeto possa ser concluído com fidelidade. [PhotoCraft](https://github.com/storytold/photocraft/blob/v0.7.0/README.md#status), [FilmCraft](https://github.com/storytold/filmcraft/blob/v0.6.0/README.md#status), [LightCraft](https://github.com/storytold/lightcraft/blob/v0.6.0/README.md#feature-status).

## O que o código do ArtCraft principal permite concluir

A estrutura separa a aplicação Tauri em Rust, o frontend React/TypeScript e os clientes de fornecedores. Os serviços alojados e o website estão no repositório `artcraft-services`. A base SQLite local guarda tarefas da aplicação. Esta separação permite alterações localizadas ao desktop, mas o clone do desktop não constitui uma instalação autónoma de todos os serviços de geração. [Estrutura documentada](https://github.com/storytold/artcraft/blob/d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373/AGENTS.md).

O código inspecionado usa os serviços de produção por defeito e guarda estado, configurações e credenciais sob `~/Artcraft`. Uma compilação de desenvolvimento pode partilhar esses dados com a app instalada. Antes de experimentar uma versão modificada, convém definir a separação dos dados de teste. [Configuração](https://github.com/storytold/artcraft/blob/d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373/crates/desktop/artcraft/src/core/state/app_env_configs/app_env_configs.rs), [pasta de dados](https://github.com/storytold/artcraft/blob/d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373/crates/desktop/artcraft/src/core/state/data_dir/app_data_root.rs).

O `main` clonado está no commit `d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373`, de 11 de outubro. A configuração Tauri marca 0.42.0, superior à release instalada. Existe também `artcraft-native`, uma interface egui em Rust que usa os mesmos clientes; a sua documentação indica ferramentas ainda com páginas de espera. Não devemos confundir o estado de `main` com as funcionalidades entregues na release. [Configuração Tauri](https://github.com/storytold/artcraft/blob/d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373/crates/desktop/artcraft/tauri.conf.json), [ArtCraft Native](https://github.com/storytold/artcraft/blob/d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373/artcraft-native/README.md).

A geração com IA pode exigir conta, créditos ou pagamento a fornecedores. Um fork não elimina esses custos nem instala os modelos localmente. A remoção da dependência dos serviços ArtCraft continua no roteiro. Isto é distinto das Crafting Apps, destinadas a editar ficheiros locais; o LightCraft, por exemplo, declara operação sem conta nem subscrição. [Preços](https://getartcraft.com/pricing), [roteiro ArtCraft](https://github.com/storytold/artcraft/blob/main/ROADMAP.md), [LightCraft](https://github.com/storytold/lightcraft/blob/v0.6.0/README.md).

## ArtCraft independente e integração com Codex

É tecnicamente plausível adaptar o desktop para fornecedores diretos, mas remover o ecrã de login não elimina as dependências do serviço. No cliente Tauri, o caminho que finaliza tarefas fal exige credenciais ArtCraft antes de descarregar resultados e os envia para a biblioteca alojada. Na versão egui, o worker também interrompe o processamento quando não existe sessão e envia os resultados para o backend. [Finalização Tauri](https://github.com/storytold/artcraft/blob/d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373/crates/desktop/artcraft/src/core/threads/third_party_task_polling_thread/handlers/fal/handle_fal_complete.rs), [worker egui](https://github.com/storytold/artcraft/blob/d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373/artcraft-native/src/backend/providers/worker.rs).

O desenho proposto tem armazenamento local de projetos, recursos e resultados; fornecedores escolhidos explicitamente; e nenhuma chamada aos serviços ArtCraft. Começar pela interface Tauri existente preserva os editores 2D/3D, enquanto a nova interface egui ainda apresenta ferramentas com páginas de espera. O primeiro critério de aceitação é abrir, editar, guardar e reabrir um projeto local sem conta ArtCraft, com os serviços ArtCraft indisponíveis.

O Codex CLI instalado é 0.160.1 e `codex login status` confirmou autenticação com ChatGPT. Um ensaio local do `app-server` completou `initialize` e `account/read`, reconhecendo uma conta do tipo `chatgpt`, sem pedidos de geração. A interface oficial permite integrar autenticação gerida pelo Codex, conversas e eventos numa aplicação própria. A proposta é comunicar localmente com esse processo e deixar o Codex gerir a sessão, sem copiar os seus tokens para os fornecedores da aplicação. [App Server](https://learn.chatgpt.com/docs/app-server), [autenticação gerida](https://learn.chatgpt.com/docs/app-server#authentication-modes).

A instalação local apresenta `image_generation` como funcionalidade estável e ativada. O protocolo gerado pela própria versão instalada inclui resultados `imageGeneration`, caminho do ficheiro produzido e falhas por limite de utilização. Isto confirma os mecanismos do cliente; ainda não confirma acesso efetivo ao modelo nem uma geração bem-sucedida. A integração de imagens precisa de um ensaio completo, com saída local e tratamento dos limites da conta.

Vídeo, áudio, malhas 3D e modelos de outros fornecedores devem usar integrações e contas próprias quando disponíveis. A presença da conta Codex não estabelece acesso a esses serviços. O plano deve mostrar as capacidades realmente disponíveis para cada fornecedor, sem prometer todo o catálogo ArtCraft.

Uma alternativa seria alojar o backend `artcraft-services` por nossa conta. O seu README exige MySQL, Redis, configuração de Elasticsearch, armazenamento de objetos e workers para parte dos fluxos. Para este uso pessoal, recomendo o armazenamento local e integrações diretas em vez dessa infraestrutura. [Backend e requisitos](https://github.com/storytold/artcraft-services/blob/main/README.md#backend).

A primeira implementação proposta é uma versão independente com identidade e pasta de dados próprias, projetos locais e uma ligação ao Codex. Depois, integrar um fornecedor direto de cada vez e validar a receção dos ficheiros sem upload para o ArtCraft. Este desenho ainda não foi implementado nem compilado.

## Três formas de adaptar as apps de edição

1. **Apps oficiais com configuração própria.** É o caminho mais curto para experimentar, receber atualizações e perceber as lacunas reais. Usar modelos de documento, recursos e predefinições onde a app os suportar.
2. **Apps oficiais com automações nossas.** É a opção que recomendo para começar a personalizar. PhotoCraft e FilmCraft documentam interfaces de comandos, CLI e MCP para agentes. Podemos guardar receitas repetíveis, como exportar variações de imagem ou montar uma sequência curta, num repositório nosso sem manter cópias do código das apps. Confirmar os comandos na versão instalada antes de depender deles. [Automação PhotoCraft](https://github.com/storytold/photocraft/blob/v0.7.0/README.md#built-for-agents), [automação FilmCraft](https://github.com/storytold/filmcraft/blob/v0.6.0/README.md#built-for-agents).
3. **Fork de uma app específica.** Faz sentido para corrigir uma incompatibilidade confirmada, acrescentar um comando ou alterar uma interação que a configuração não permita. Implica integrar atualizações do original e verificar cada alteração. Correções de interesse geral podem ser propostas ao projeto original para reduzir manutenção futura.

O Launcher documenta um modo de desenvolvimento `local-mirror`, com builds de checkouts locais e feed em localhost. Pode servir para testes de versões próprias numa fase posterior. As releases oficiais não ativam esse modo. Não é necessário montar uma distribuição pública para experimentar uma alteração. [Builds próprios no Launcher](https://github.com/storytold/craft-launcher/blob/v0.3.2/README.md#installing-your-own-builds).

Se distribuirmos uma versão modificada, temos de conservar os avisos das licenças e rever as marcas e recursos incluídos. O NOTICE do ArtCraft exclui marcas e certos recursos de terceiros da licença do código. O Launcher tem condições específicas de branding para versões modificadas distribuídas. [Licença MIT](https://github.com/storytold/artcraft/blob/main/LICENSE-MIT), [NOTICE](https://github.com/storytold/artcraft/blob/main/NOTICE), [branding Launcher](https://github.com/storytold/craft-launcher/blob/v0.3.2/docs/brand/LICENSE-brand.txt).

## Piloto proposto

1. Escolher uma peça curta que combine as áreas habituais, por exemplo um vídeo de 15 a 30 segundos com um cenário 3D, elementos gráficos, animação e áudio.
2. Instalar o Launcher oficial, PhotoCraft, VectorCraft, FilmCraft, EffectCraft e SoundCraft, usando os pacotes universais. Registar as versões usadas para tornar as observações reproduzíveis. Usar o Blender existente para o cenário 3D.
3. Abrir cópias de ficheiros representativos, fazer alterações pequenas, guardar, fechar, reabrir e exportar. Confirmar camadas, fontes, cor, transparência e sincronização áudio/vídeo. Testar a passagem de ficheiros entre as apps, sem assumir integração direta nem compatibilidade dos formatos nativos.
4. Medir a experiência no Mac com ficheiros do tamanho habitual. Começar por cenas ou sequências pequenas, pois benchmarks de outros computadores não provam o desempenho aqui.
5. Registar cada necessidade como configuração, automação externa ou alteração ao código de uma app. Fazer um fork apenas para os casos da última categoria e manter cada mudança pequena e verificável.

O critério para adoção é concluir o fluxo escolhido sem perda de informação relevante e com desempenho aceitável. A instalação, isoladamente, não cumpre esse critério.

## Verificação e limites

Foram inspecionados documentação, releases, código de configuração, caminhos de geração e metadados das apps existentes. A aceitação do ArtCraft pelo Gatekeeper foi verificada antes da remoção. Depois da remoção, foram verificados o destino no Lixo, a ausência da app em Applications e o fim do processo. Também foram consultados o estado de autenticação e as funcionalidades do Codex CLI, gerado o esquema do seu protocolo numa pasta temporária e testada a ligação local ao app-server para ler o estado da conta. Não foram executados testes do projeto, compilação ou ensaios de geração/edição/exportação; não foram instaladas dependências nem alterado código.

Foi criado um clone superficial e esparso em `/Users/igor/Documents/artcraft`, com código e documentação. Recursos binários ficaram fora do checkout; este terá de ser expandido antes de uma compilação que os use. O único ficheiro acrescentado ao checkout é esta avaliação. O repositório original continua como `origin`; não foi criado um fork no GitHub.

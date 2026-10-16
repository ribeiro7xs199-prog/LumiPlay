# LumiPlay — melhorias de detalhes, comunidade e administração

## Novidades
- Modal de detalhes ampliado com metadados, avaliação de 1 a 5 estrelas, comentários e estatísticas.
- Contagem de visitantes únicos que abriram o detalhe e que chegaram aos últimos 20 minutos de reprodução (ou ao fim do vídeo).
- A mesma pessoa pode atualizar a própria avaliação/comentário no mesmo navegador.
- Painel administrativo com botão Editar para cada título.
- Seleção de títulos a preservar e ação “Excluir todos, exceto selecionados”. A exclusão em massa exige login de administrador e confirmação explícita.
- Mantém a importação TMDB existente e o catálogo Supabase.

## Passos obrigatórios de instalação
1. Faça backup do site e do Supabase.
2. No Supabase, abra SQL Editor e execute `supabase-migration.sql`.
3. Publique todos os arquivos deste ZIP no Netlify, mantendo a estrutura de pastas.
4. Entre no LumiPlay com a conta administradora.
5. Teste primeiro a edição de um título e a exclusão de um único título. Só depois teste a exclusão em massa.
6. Abra os detalhes de um título, registre uma avaliação/comentário e confira se aparece após recarregar.

## Observações importantes
- O site usa `localStorage` para identificar um visitante por navegador. Cliques e conclusões são estimativas de visitantes únicos por navegador, não identidade verificada; limpar dados ou usar outro dispositivo cria outra identificação.
- “Assistiu até o fim” é registrado quando a reprodução chega aos últimos 20 minutos ou quando o vídeo termina. É uma regra aproximada solicitada pelo projeto, não uma prova de que a pessoa prestou atenção.
- As tabelas de comunidade são públicas para leitura e aceitam envios anônimos com limites de tamanho. Como não há conta de usuário, os nomes são genéricos e um visitante pode tentar falsificar sua identificação; para produção pública maior, adicione autenticação, moderação e proteção contra abuso.
- A função de exclusão em massa apaga do Supabase os títulos não marcados para preservação. Faça backup antes de usá-la.
- Execute o SQL apenas no projeto Supabase correto. Não publique a chave `service_role` no navegador.

## Correção de exclusão e cadastro por pesquisa TMDB
- A exclusão individual agora confirma o resultado do Supabase antes de remover o título da interface. O código procura a linha por ID do banco, ou por TMDB + tipo, ou por app_id, para lidar com registros antigos que não tinham app_id.
- A exclusão em massa atualiza o texto de progresso e sempre restaura o botão em `finally`, inclusive quando há erro.
- O botão “Adicionar filme ou série pelo TMDB” abre uma busca administrativa. Ao selecionar um resultado, os metadados são preenchidos e o título é salvo sem URL de vídeo. A tela de edição abre em seguida para colar a URL direta MP4.
- A conta precisa ser o administrador autorizado; se a exclusão retornar zero linhas, verifique as políticas RLS de DELETE/SELECT do Supabase.

## Player EmbedMovies (atualização)

- Filmes com `tmdb_id` numérico abrem `https://myembed.biz/filme/{tmdb_id}`.
- Séries com `tmdb_id` numérico abrem `https://myembed.biz/serie/{tmdb_id}`; ao escolher um episódio cadastrado na interface, o player abre `https://myembed.biz/serie/{tmdb_id}/{temporada}/{episodio}`.
- Se o título não tiver um ID TMDB numérico, o site mantém a opção de URL direta de vídeo já cadastrada.
- O LumiPlay não adiciona publicidade própria nesta integração. Eventuais anúncios dentro do iframe são controlados pelo EmbedMovies e não podem ser removidos com segurança pelo código do LumiPlay.


## Player MegaEmbed (integração por ID TMDB)

O player do catálogo usa os endpoints documentados do MegaEmbed (domínio mgeb.site):
- Filme: `https://mgeb.site/embed/ID_TMDB`
- Série: `https://mgeb.site/embed/ID_TMDB/TEMPORADA/EPISÓDIO`

A temporada e o episódio começam em 1. Quando não foi escolhido um episódio cadastrado no LumiPlay, o player tenta abrir a temporada 1, episódio 1. O site do MegaEmbed anuncia a opção dublada como padrão, mas o idioma real depende das fontes de vídeo disponíveis.

**Limite importante:** isto não importa automaticamente todos os filmes e séries do mundo. O TMDB é um catálogo de metadados; cada título precisa ser adicionado ao LumiPlay (por pesquisa/importação) e o MegaEmbed pode não ter stream disponível para todos. O MegaEmbed descreve seu serviço como tendo publicidade mínima, não ausência garantida de anúncios. É um serviço de terceiros e sua disponibilidade/política pode mudar.


## Correção adicional do player e cadastro manual do ID TMDB
- Corrigido o teste numérico do ID TMDB que impedia IDs válidos de serem reconhecidos pelo player.
- O formulário administrativo agora tem o campo “ID TMDB (somente números)”, preenchido ao editar e salvo no catálogo.
- Após publicar, edite o título, informe o ID numérico e salve. Para séries, o player tenta temporada 1, episódio 1 se nenhum episódio estiver selecionado. Isso não garante que o serviço externo tenha vídeo disponível.


## Editor visual de temporadas e episódios
No painel administrativo, ao adicionar ou editar uma série:
1. Use **＋ Adicionar temporada** para criar cada temporada.
2. Dentro da temporada, use **＋ Adicionar episódio** para adicionar episódios.
3. Preencha o nome e a descrição opcional de cada episódio.
4. O campo técnico JSON é atualizado automaticamente; não é necessário editar JSON manualmente.
5. Clique em **Salvar alterações** para persistir no catálogo.
O player continua montando o endereço MegaEmbed a partir do ID TMDB, índice da temporada e índice do episódio; o serviço externo ainda precisa disponibilizar a fonte.


## Dados automáticos dos episódios
Conecte o TMDB pelo botão de nuvem, edite uma série e informe seu ID TMDB. Em cada episódio, toque em “Buscar nome, descrição e ID no TMDB”. O nome, sinopse e ID individual são consultados em português quando disponíveis. O ID individual é opcional para o MegaEmbed; o player usa ID da série + temporada + episódio. A ordem no editor determina a numeração.

## Atualização: MegaEmbed, avaliações da comunidade e dados pessoais
- O player MegaEmbed foi mantido/restaurado: filmes usam `https://mgeb.site/embed/{tmdb_id}` e séries usam `https://mgeb.site/embed/{tmdb_id}/{season}/{episode}`. A disponibilidade e o idioma dependem do serviço externo.
- As estrelas das capas agora representam a média das avaliações enviadas pelos visitantes do LumiPlay, com a quantidade de votos. Títulos sem votos aparecem como “★ Nova”.
- Favoritos e progresso de reprodução continuam guardados no armazenamento local do navegador. Isso preserva os dados no mesmo navegador/dispositivo; não sincroniza automaticamente entre aparelhos ou após limpar os dados do navegador.
- Avaliações e comentários são compartilhados pelo Supabase, caso as tabelas e políticas de `supabase-migration.sql` estejam configuradas.
- O player externo não permite garantir retomada em segundos exatos, porque o iframe de outro domínio não expõe sua posição de reprodução ao LumiPlay.


## Histórico e lista pessoal
A versão inclui uma seção **Assistidos** com filtro por filmes/séries e pesquisa, e a seção **Salvos** para a lista pessoal. O histórico, a lista e o progresso são armazenados no navegador atual (localStorage); sem autenticação e sincronização por usuário no backend, eles não migram automaticamente para outros aparelhos. Abrir um título/episódio registra a atividade, inclusive quando a reprodução usa um player externo.


## Correção da TV ao Vivo
- Os controles de adicionar/importar/exportar canais foram movidos para o painel administrativo, após entrar com a conta administradora.
- O formulário aceita tanto uma URL HTTPS quanto o iframe completo copiado de um site, extraindo o atributo `src`.
- Se o provedor bloquear `iframe` por política de segurança, isso não pode ser corrigido pelo site LumiPlay; é necessário um embed autorizado que permita incorporação.
- A lista de canais continua armazenada localmente neste navegador nesta versão; não é sincronizada entre dispositivos.

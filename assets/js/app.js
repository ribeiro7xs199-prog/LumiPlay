(() => {
  "use strict";
  const STORAGE_KEY = "cinebase.catalog.v2";
  const OLD_STORAGE_KEY = "cinebase.catalog.v1";
  const FAVORITES_KEY = "cinebase.favorites.v1";
  const PROGRESS_KEY = "cinebase.progress.v1";
  const WATCH_HISTORY_KEY = "lumiplay.watch-history.v1";
  const TMDB_CACHE_KEY = "lumiplay.tmdb.cache.v1";
  const COMMUNITY_RATINGS_KEY = "lumiplay.community.ratings.v1";
  const TMDB_CACHE_TTL = 1000 * 60 * 60 * 24 * 30; // 30 dias
  const DISCOVERY_CACHE_TTL = 1000 * 60 * 10; // 10 minutos
  const TMDB_KEY = "cinebase.tmdb.credential.v1";
  const TMDB_AUTO_KEY = "cinebase.tmdb.autoload.v1";
  let searchTimer = null;
  let discoveryPage = 1;
  let discoveryLoading = false;
  let discoveryHasMore = true;
  let bulkImportRunning = false;
  let bulkImportPause = false;
  const BULK_STATE_KEY = "lumiplay.tmdb.bulk.v1";
  let tmdbCredential = localStorage.getItem(TMDB_KEY) || "";
  const $ = (selector) => document.querySelector(selector);
  // LumiPlay Supabase config: publishable key is intended for browser use; RLS protects writes.
  const SUPABASE_URL = "https://oogbmikjxargdsizrgom.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_F3ZlMBNtbsGz_s_hhyWFng_OCl2wJdt";
  const ADMIN_UID = "f6144686-40dd-4e8e-8e4d-e49febce94ec";
  const SUPABASE_SESSION_KEY = "lumiplay.supabase.session.v1";
  let supabaseClient = null;
  let adminSession = null;
  let backendReady = false;
  try {
    if (window.supabase?.createClient) {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, storageKey:SUPABASE_SESSION_KEY}});
    }
  } catch (error) { console.warn("Supabase indisponível", error); }
  let activeFilter = "Tudo";
  let selectedItemId = null;
  let toastTimer = null;
  let progressTimer = null;
  const VISITOR_KEY = "lumiplay.visitor.v1";
  let visitorId = localStorage.getItem(VISITOR_KEY);
  if (!visitorId) { visitorId = (crypto.randomUUID ? crypto.randomUUID() : "v-" + Date.now().toString(36) + Math.random().toString(36).slice(2)); localStorage.setItem(VISITOR_KEY, visitorId); }
  let currentRating = 0;
  const preservedIds = new Set();
  let eventCounts = {clicks:0, completions:0};

  // Catálogo inicial vazio; nenhum título de demonstração.
  const starterCatalog = [];

  function safeParse(value, fallback) { try { const result = JSON.parse(value); return result ?? fallback; } catch (_) { return fallback; } }
  function loadCatalog() {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) {
      const parsed = safeParse(current, null);
      if (Array.isArray(parsed)) return parsed;
    }
    const old = localStorage.getItem(OLD_STORAGE_KEY);
    if (old) {
      const parsed = safeParse(old, null);
      if (Array.isArray(parsed)) {
        const upgraded = parsed.map(item => ({seasons:[], ...item}));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(upgraded));
        return upgraded;
      }
    }
    return starterCatalog.map(item => ({...item, seasons: item.seasons || []}));
  }
  let catalog = loadCatalog();
  const CLEANUP_VERSION_KEY = "lumiplay.catalog.examples.cleaned.v2";
  if (localStorage.getItem(CLEANUP_VERSION_KEY) !== "yes") {
    catalog = [];
    localStorage.setItem(STORAGE_KEY, "[]");
    localStorage.removeItem(OLD_STORAGE_KEY);
    localStorage.setItem(CLEANUP_VERSION_KEY, "yes");
  }
  const starterById = Object.fromEntries(starterCatalog.map(item => [item.id, item]));
  let demoCatalogUpdated = false;
  catalog = catalog.map(item => {
    if (starterById[item.id] && String(item.id).startsWith("demo-")) {
      demoCatalogUpdated = true;
      return {...starterById[item.id]};
    }
    return item;
  });
  // Backfill bundled covers into previously saved demo entries that had empty poster fields.
  const demoPosterByTitle = {
    "Horizonte Oculto":"assets/posters/horizonte-oculto.svg",
    "Código Aurora":"assets/posters/codigo-aurora.svg",
    "Depois da Chuva":"assets/posters/depois-da-chuva.svg",
    "Fora de Órbita":"assets/posters/fora-de-orbita.svg",
    "O Último Farol":"assets/posters/ultimo-farol.svg",
    "Pequenos Gigantes":"assets/posters/pequenos-gigantes.svg",
    "A Cidade Suspensa":"assets/posters/cidade-suspensa.svg",
    "Arquivo Zero":"assets/posters/arquivo-zero.svg"
  };
  let coversUpdated = false;
  catalog = catalog.map(item => {
    if (!String(item.poster || "").trim() && demoPosterByTitle[item.title]) {
      coversUpdated = true;
      return {...item, poster:demoPosterByTitle[item.title]};
    }
    return item;
  });
  let favorites = safeParse(localStorage.getItem(FAVORITES_KEY) || "[]", []);
  let communityRatings = safeParse(localStorage.getItem(COMMUNITY_RATINGS_KEY) || "{}", {});
  let progress = safeParse(localStorage.getItem(PROGRESS_KEY) || "{}", {});
  let watchHistory = safeParse(localStorage.getItem(WATCH_HISTORY_KEY) || "[]", []);
  let tmdbCache = safeParse(localStorage.getItem(TMDB_CACHE_KEY) || "{}", {});
  function saveTmdbCache() {
    try { localStorage.setItem(TMDB_CACHE_KEY, JSON.stringify(tmdbCache)); }
    catch (_) { /* cache é descartável; não impedir o uso do site se o armazenamento estiver cheio */ }
  }
  function cacheGet(key) {
    const entry = tmdbCache[key];
    if (!entry || !entry.savedAt || Date.now() - entry.savedAt > TMDB_CACHE_TTL) return null;
    return entry.value ?? null;
  }
  function cacheSet(key, value) {
    tmdbCache[key] = {savedAt:Date.now(), value};
    // Limita o cache para não encher o armazenamento de TVs antigas.
    const keys = Object.keys(tmdbCache);
    if (keys.length > 180) {
      keys.sort((a,b)=>(tmdbCache[a]?.savedAt||0)-(tmdbCache[b]?.savedAt||0));
      keys.slice(0, keys.length - 180).forEach(k => delete tmdbCache[k]);
    }
    saveTmdbCache();
  }
  function tmdbIdentity(item) {
    const match = String(item?.id || "").match(/^tmdb-(tv|movie)-(\d+)$/);
    const id = item?.tmdbId || (match ? match[2] : "");
    const type = item?.type === "Série" || item?.tmdbMediaType === "tv" || match?.[1] === "tv" ? "tv" : "movie";
    return /^\d+$/.test(String(id)) ? `${type}:${id}` : "";
  }
  function dedupeCatalog(items) {
    const output = [], byTmdb = new Map(), byId = new Map();
    for (const original of items || []) {
      if (!original) continue;
      const item = {...original};
      const identity = tmdbIdentity(item);
      const idKey = String(item.id || "");
      const priorIndex = (identity && byTmdb.has(identity)) ? byTmdb.get(identity) : byId.get(idKey);
      if (priorIndex !== undefined) {
        const prior = output[priorIndex];
        // Preferir metadados novos, mas preservar vídeo, temporadas e progresso já conhecidos.
        output[priorIndex] = {...prior, ...item,
          id: prior.id || item.id,
          tmdbId: prior.tmdbId || item.tmdbId,
          video: prior.video || item.video || "",
          seasons: (prior.seasons?.length ? prior.seasons : item.seasons) || [],
          dbId: prior.dbId || item.dbId};
        continue;
      }
      const index = output.length;
      output.push(item);
      byId.set(idKey, index);
      if (identity) byTmdb.set(identity, index);
    }
    return output;
  }

  function setBackendStatus(message, isError=false) {
    const el = $("#backendStatus");
    if (el) { el.textContent = message; el.classList.toggle("backend-error", !!isError); }
  }
  function rowToItem(row) {
    return {dbId:row.id, id:row.app_id || (row.tmdb_id ? `tmdb-${row.tipo === "serie" ? "tv" : "movie"}-${row.tmdb_id}` : `db-${row.id}`), title:row.titulo || "Sem título", type:row.tipo === "serie" ? "Série" : "Filme", genre:row.genero || "", year:row.ano ? String(row.ano) : "", description:row.sinopse || "", poster:row.capa_url || "", video:row.video_url || "", color:"#6650a4", seasons:Array.isArray(row.temporadas) ? row.temporadas : [], tmdbId:row.tmdb_id || undefined};
  }
  function itemToRow(item) {
    const tmdbMatch = String(item.id || "").match(/^tmdb-(tv|movie)-(\d+)$/);
    return {app_id:String(item.id), tmdb_id:item.tmdbId || (tmdbMatch ? Number(tmdbMatch[2]) : null), titulo:String(item.title || "Sem título"), tipo:item.type === "Série" ? "serie" : "filme", ano:/^\d{4}$/.test(String(item.year||"")) ? Number(item.year) : null, genero:item.genre || "", capa_url:item.poster || "", sinopse:item.description || "", video_url:item.video || "", temporadas:Array.isArray(item.seasons) ? item.seasons : []};
  }
  async function loadSharedCatalog() {
    if (!supabaseClient) { setBackendStatus("Não foi possível carregar a biblioteca Supabase. Confira a conexão com a internet.", true); return; }
    try {
      const {data, error} = await supabaseClient.from("catalogo").select("*").order("criado_em", {ascending:false});
      if (error) throw error;
      const shared = (data || []).map(rowToItem);
      // Shared rows take precedence; deduplicate by TMDB identity and internal ID.
      catalog = dedupeCatalog([...shared, ...catalog]);
      renderCatalog();
      backendReady = true;
      setBackendStatus("Banco online conectado. O catálogo compartilhado foi carregado.");
    } catch (error) {
      console.error("Falha ao carregar catálogo compartilhado", error);
      setBackendStatus("Não foi possível ler o banco. Confira se a coluna app_id foi criada e se a política de leitura está ativa.", true);
    }
  }
  async function saveItemToCloud(item) {
    if (!supabaseClient || !adminSession || adminSession.user?.id !== ADMIN_UID) return false;
    const {error} = await supabaseClient.from("catalogo").upsert(itemToRow(item), {onConflict:"app_id"});
    if (error) { console.error(error); showToast("Erro ao salvar no banco: " + error.message); return false; }
    return true;
  }
  async function deleteItemFromCloud(item) {
    if (!supabaseClient || !adminSession || adminSession.user?.id !== ADMIN_UID) {
      showToast("Entre como administrador para excluir do catálogo compartilhado.");
      return false;
    }
    try {
      let query = supabaseClient.from("catalogo").select("id,app_id,tmdb_id,tipo");
      if (item.dbId) query = query.eq("id", item.dbId);
      else if (item.tmdbId) query = query.eq("tmdb_id", Number(item.tmdbId)).eq("tipo", item.type === "Série" ? "serie" : "filme");
      else query = query.eq("app_id", String(item.id));
      const lookup = await query.limit(10);
      if (lookup.error) throw lookup.error;
      const rows = lookup.data || [];
      if (!rows.length) return true; // Não existe registro remoto para este item local.
      for (const row of rows) {
        let deletion = supabaseClient.from("catalogo").delete().eq("id", row.id).select("id");
        const result = await deletion;
        if (result.error) throw result.error;
        if (!result.data || !result.data.length) throw new Error("Nenhuma linha foi excluída. Verifique as políticas RLS do Supabase e se você está conectado como administrador.");
      }
      return true;
    } catch (error) {
      console.error("Falha ao excluir título no Supabase", error);
      showToast("Erro ao excluir do banco: " + (error.message || "permissão negada"));
      return false;
    }
  }
  async function refreshAdminState() {
    if (!supabaseClient) return;
    try {
      const {data:{session}} = await supabaseClient.auth.getSession();
      adminSession = session;
      const isAdmin = !!session && session.user?.id === ADMIN_UID;
      $("#adminLoginBox")?.classList.toggle("hidden", isAdmin);
      $("#adminLoggedBox")?.classList.toggle("hidden", !isAdmin);
      $("#titleForm")?.classList.toggle("hidden", !isAdmin);
      $("#adminAddTitle")?.classList.toggle("hidden", !isAdmin);
      $("#bulkImportPanel")?.classList.toggle("hidden", !isAdmin);
      $("#resetCatalog")?.classList.toggle("hidden", !isAdmin);
      $("#adminIdentity").textContent = isAdmin ? `Conectado como ${session.user.email}. Alterações serão salvas no banco compartilhado.` : "";
      if (session && !isAdmin) { await supabaseClient.auth.signOut(); adminSession = null; setBackendStatus("Conta autenticada, mas sem permissão de administrador.", true); }
      else if (isAdmin) setBackendStatus("Administrador autenticado. Você pode gerenciar o catálogo online.");
      renderAdminList();
    } catch (error) { console.warn(error); }
  }
  async function loginAdmin() {
    const email = $("#adminEmail").value.trim(), password = $("#adminPassword").value;
    if (!email || !password) { showToast("Informe e-mail e senha."); return; }
    if (!supabaseClient) { showToast("Biblioteca Supabase não carregou. Recarregue a página."); return; }
    const button = $("#adminLogin"); button.disabled = true; button.textContent = "Entrando…";
    const {data, error} = await supabaseClient.auth.signInWithPassword({email, password});
    button.disabled = false; button.textContent = "Entrar como administrador";
    if (error) { showToast("Falha no login: " + error.message); return; }
    if (data.user?.id !== ADMIN_UID) { await supabaseClient.auth.signOut(); showToast("Esta conta não tem permissão de administrador."); return; }
    adminSession = data.session; $("#adminPassword").value = "";
    await refreshAdminState(); await loadSharedCatalog(); await loadTvChannelsFromCloud(); renderCatalog(); showToast("Login administrativo concluído.");
  }
  function saveCatalog() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(catalog)); return true; }
    catch (_) { showToast("Não foi possível salvar. O armazenamento do navegador pode estar cheio."); return false; }
  }
  if (coversUpdated || demoCatalogUpdated) saveCatalog();
  function saveFavorites() { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)); }
  function saveProgress() { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); }
  function saveWatchHistory() { try { localStorage.setItem(WATCH_HISTORY_KEY, JSON.stringify(watchHistory.slice(0,100))); } catch (_) {} }
  function recordWatch(item, episode=null, seasonIndex=null, episodeIndex=null) {
    if (!item) return;
    const season = episode ? Number(episode.seasonNumber ?? (Number(seasonIndex||0)+1)) : null;
    const ep = episode ? Number(episode.episodeNumber ?? (Number(episodeIndex||0)+1)) : null;
    const key = episode ? `${item.id}:s${season}:e${ep}` : String(item.id);
    watchHistory = [{key,id:String(item.id),title:item.title,type:item.type,poster:item.poster||item.capa_url||"",episode:episode?.title||"",season,episodeNumber:ep,watchedAt:Date.now()}, ...watchHistory.filter(entry=>entry.key!==key)].slice(0,100);
    saveWatchHistory();
    renderWatchHistory();
  }
  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  }
  function safeURL(value) {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; }
    catch (_) { return ""; }
  }
  function safePoster(value) {
    const raw = String(value || "").trim();
    if (/^assets\/posters\/[a-z0-9-]+\.svg$/i.test(raw)) return raw;
    return safeURL(raw);
  }
  function showToast(message) {
    const toast = $("#toast"); toast.textContent = message; toast.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
  }
  function findItem(id) { return catalog.find(item => item.id === id); }
  function isFavorite(id) { return favorites.includes(id); }
  function posterMarkup(item) {
    const title = escapeHTML(item.title), poster = safePoster(item.poster);
    const color = /^#[0-9a-f]{6}$/i.test(item.color || "") ? item.color : "#7654ce";
    const rating = communityRatings[String(item.id)];
    const ratingBadge = rating?.count ? `<span class="site-rating" title="Avaliação dos usuários LumiPlay">★ ${Number(rating.average).toFixed(1)} <small>(${rating.count})</small></span>` : '<span class="site-rating site-rating-empty" title="Ainda sem avaliações da comunidade">★ Nova</span>';
    return `<div class="poster" style="--poster-glow:${color}">${poster ? `<img src="${escapeHTML(poster)}" alt="Capa de ${title}" loading="lazy" onerror="this.remove()">` : ""}<span class="poster-tag">${escapeHTML(item.type)}</span>${ratingBadge}<span class="poster-title">${title}</span><span class="poster-play"><span>▶</span></span>${isFavorite(item.id) ? '<span class="favorite-badge">♥</span>' : ""}</div>`;
  }
  function cardMarkup(item) {
    return `<article class="title-card" tabindex="0" role="button" aria-label="Ver detalhes de ${escapeHTML(item.title)}" data-id="${escapeHTML(item.id)}">${posterMarkup(item)}<div class="card-meta"><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.year || "Ano não informado")} · ${escapeHTML(item.genre || item.type)}</p></div></article>`;
  }
  function filteredCatalog() {
    const term = $("#searchInput").value.trim().toLocaleLowerCase("pt-BR");
    return catalog.filter(item => {
      const matchesType = activeFilter === "Tudo" || item.type === activeFilter;
      const genre = $("#genreFilter")?.value || "Tudo";
      const matchesGenre = genre === "Tudo" || String(item.genre || "").toLocaleLowerCase("pt-BR").includes(genre.toLocaleLowerCase("pt-BR"));
      const haystack = [item.title,item.genre,item.year,item.description].join(" ").toLocaleLowerCase("pt-BR");
      return matchesType && matchesGenre && haystack.includes(term);
    });
  }
  async function loadCommunityRatings() {
    if (!supabaseClient) return;
    try {
      const {data,error} = await supabaseClient.from("catalogo_feedback").select("app_id,avaliacao").not("avaliacao","is",null).limit(5000);
      if (error) throw error;
      const sums = {};
      (data || []).forEach(row => {
        const rating = Number(row.avaliacao);
        if (!row.app_id || rating < 1 || rating > 5) return;
        const key = String(row.app_id);
        if (!sums[key]) sums[key] = {sum:0,count:0};
        sums[key].sum += rating; sums[key].count++;
      });
      communityRatings = Object.fromEntries(Object.entries(sums).map(([key,value]) => [key,{average:value.sum/value.count,count:value.count}]));
      try { localStorage.setItem(COMMUNITY_RATINGS_KEY, JSON.stringify(communityRatings)); } catch (_) {}
      renderCatalog();
    } catch (error) { console.warn("Não foi possível carregar as avaliações da comunidade", error); }
  }
  function renderCatalog() {
    const items = filteredCatalog();
    $("#catalogGrid").innerHTML = items.map(cardMarkup).join("");
    $("#emptyState").classList.toggle("hidden", items.length > 0);
    $("#catalogGrid").classList.toggle("hidden", items.length === 0);
    $("#catalogHeading").textContent = $("#searchInput").value.trim() ? "Resultados da busca" : (activeFilter === "Tudo" ? "Em destaque" : activeFilter === "Filme" ? "Filmes" : "Séries");
    $("#totalTitles").textContent = catalog.length;
    $("#totalMovies").textContent = catalog.filter(item => item.type === "Filme").length;
    $("#totalSeries").textContent = catalog.filter(item => item.type === "Série").length;
    renderContinue();
    renderMyList();
    const status = $("#catalogStatus");
    if (status && tmdbCredential) status.textContent = "Catálogo online conectado · os dados vêm do TMDB.";
  }
  function setFilter(filter) {
    activeFilter = filter;
    document.querySelectorAll("[data-filter]").forEach(button => button.classList.toggle("active", button.dataset.filter === filter));
    $("#myListSection").classList.add("hidden");
    $("#watchHistorySection").classList.add("hidden");
    $("#liveTvSection")?.classList.add("hidden");
    $("#continueSection").classList.toggle("hidden", Object.keys(progress).length === 0);
    $("#catalogSection").classList.remove("hidden");
    renderCatalog();
  }
  // Modal names used by the app are mapped to the actual HTML element IDs.
  // This prevents clicks from failing when logical names omit the "Modal" suffix.
  const modalIds = {details:"detailsModal", player:"playerModal", admin:"adminModal", info:"infoModal", tmdb:"tmdbModal", tvChannel:"tvChannelModal", tvPlayer:"tvPlayerModal"};
  function openModal(id) {
    const modal = $("#" + (modalIds[id] || id));
    if (!modal) { console.error("Modal não encontrado:", id); return; }
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }
  function closeModal(id) {
    const modal = $("#" + (modalIds[id] || id));
    if (!modal) { console.error("Modal não encontrado:", id); return; }
    modal.classList.add("hidden");
    if (![...document.querySelectorAll(".modal")].some(modal => !modal.classList.contains("hidden"))) document.body.style.overflow = "";
    if (id === "player" || id === "playerModal") {
      const video = $("#videoPlayer"); if (video) { video.pause(); video.removeAttribute("src"); video.load(); video.classList.remove("hidden"); }
      const embed = $("#embedPlayer"); if (embed) { embed.src = "about:blank"; embed.classList.add("hidden"); }
      $("#videoPlaceholder").classList.remove("hidden"); clearInterval(progressTimer);
    }
  }
  function openDetails(item) {
    if (!item) return;
    selectedItemId = item.id;
    trackTitleEvent(item, "click");
    $("#detailsTitle").textContent = item.title;
    $("#detailsEyebrow").textContent = item.type === "Série" ? "SÉRIE" : "FILME";
    $("#detailsMeta").textContent = [item.year, item.genre, item.type].filter(Boolean).join("  •  ");
    $("#detailsDescription").textContent = item.description || "Nenhuma descrição cadastrada.";
    const hero = $("#detailsHero");
    const posterUrl = safePoster(item.poster);
    const backdropUrl = safePoster(item.backdrop || item.backdropUrl || item.poster);
    hero.style.setProperty("--details-backdrop", backdropUrl ? `url("${backdropUrl.replace(/["\\\\]/g, "")}")` : "none");
    hero.innerHTML = `<div class="details-backdrop-image" aria-hidden="true"></div><div class="details-poster-wrap">${posterUrl ? `<img class="details-poster" src="${escapeHTML(posterUrl)}" alt="Capa de ${escapeHTML(item.title)}">` : `<div class="details-poster details-art"><span>${escapeHTML(item.title)}</span></div>`}</div>`;
    $("#detailsFavorite").textContent = isFavorite(item.id) ? "♥ Remover da minha lista" : "♡ Adicionar à minha lista";
    const isSeries = item.type === "Série";
    const seasonCount = Array.isArray(item.seasons) ? item.seasons.length : 0;
    const episodeCount = Array.isArray(item.seasons) ? item.seasons.reduce((n, season) => n + (season.episodes?.length || 0), 0) : 0;
    if (isSeries) {
      $("#episodeArea").classList.remove("hidden");
      $("#episodeList").innerHTML = '<p class="form-hint">Carregando temporadas e episódios…</p>';
      $("#seasonSelect").innerHTML = '<option>Carregando…</option>';
    } else $("#episodeArea").classList.add("hidden");
    $("#detailsPlay").textContent = item.type === "Série" ? "▶ Assistir" : "▶ Assistir";
    if (isSeries) {
      if (item.seasons?.length) {
        $("#seasonSelect").innerHTML = item.seasons.map((season,index) => `<option value="${index}">${escapeHTML(season.name || `Temporada ${index+1}`)}</option>`).join("");
        renderEpisodes(item, 0);
      } else if (tmdbCredential && item.tmdbId) {
        loadSeriesEpisodes(item).catch(error => { console.warn(error); if (selectedItemId === item.id) $("#episodeList").innerHTML = `<p class="form-hint">Não foi possível carregar os episódios automaticamente: ${escapeHTML(error.message)}. Confira a conexão do TMDB.</p>`; });
      } else {
        $("#episodeList").innerHTML = '<p class="form-hint">Esta série ainda não tem episódios cadastrados. Conecte o TMDB ou adicione as temporadas no painel administrativo.</p>';
      }
    }
    currentRating = 0; $("#commentText").value = ""; renderRatingStars();
    loadTitleCommunity(item);
    openModal("details");
  }
  async function loadSeriesEpisodes(item) {
    const identity = tmdbIdentity(item);
    if (!identity || !identity.startsWith("tv:")) throw new Error("ID TMDB de série inválido.");
    const cacheKey = `series:${item.tmdbId}:episodes`;
    const cached = cacheGet(cacheKey);
    if (Array.isArray(cached) && cached.length && cached.every(s => Array.isArray(s.episodes))) {
      item.seasons = cached;
      if (selectedItemId === item.id) {
        $("#seasonSelect").innerHTML = cached.map((season,index) => `<option value="${index}">${escapeHTML(season.name || `Temporada ${season.seasonNumber ?? index+1}`)} (${season.episodes.length})</option>`).join("");
        const total = cached.reduce((sum, season) => sum + season.episodes.length, 0);
        $("#detailsMeta").textContent = [item.year,item.genre,`${cached.length} temporada(s)`,`${total} episódio(s)`].filter(Boolean).join(" • ");
        renderEpisodes(item, 0);
      }
      return;
    }
    const details = await tmdbRequest(`tv/${encodeURIComponent(item.tmdbId)}`);
    const seasonsMeta = (details.seasons || []).filter(season => Number(season.season_number) > 0);
    const seasons = [];
    for (const meta of seasonsMeta) {
      const seasonNumber = Number(meta.season_number);
      const seasonCacheKey = `series:${item.tmdbId}:season:${seasonNumber}`;
      let data = cacheGet(seasonCacheKey);
      if (!data) {
        data = await tmdbRequest(`tv/${encodeURIComponent(item.tmdbId)}/season/${seasonNumber}`);
        cacheSet(seasonCacheKey, data);
      }
      seasons.push({name:meta.name || `Temporada ${seasonNumber}`, seasonNumber, episodes:(data.episodes || []).map(ep => ({
        title:ep.name || `Episódio ${ep.episode_number}`, description:ep.overview || "",
        tmdbEpisodeId:ep.id ? String(ep.id) : "", episodeNumber:Number(ep.episode_number),
        seasonNumber, still:ep.still_path ? "https://image.tmdb.org/t/p/w500"+ep.still_path : ""
      }))});
    }
    if (!seasons.length) throw new Error("O TMDB não retornou temporadas para esta série.");
    item.seasons = seasons;
    cacheSet(cacheKey, seasons);
    item.backdrop = details.backdrop_path ? "https://image.tmdb.org/t/p/w1280"+details.backdrop_path : item.backdrop;
    saveCatalog();
    if (supabaseClient && adminSession?.user?.id === ADMIN_UID) await saveItemToCloud(item);
    if (selectedItemId !== item.id) return;
    $("#seasonSelect").innerHTML = seasons.map((season,index) => `<option value="${index}">${escapeHTML(season.name)} (${season.episodes.length})</option>`).join("");
    const totalEpisodes = seasons.reduce((sum, season) => sum + season.episodes.length, 0);
    $("#detailsMeta").textContent = [item.year,item.genre,`${seasons.length} temporada(s)`,`${totalEpisodes} episódio(s)`].filter(Boolean).join(" • ");
    renderEpisodes(item, 0);
  }
  function renderRatingStars() {
    document.querySelectorAll("#ratingInput [data-rating]").forEach(button => {
      button.classList.toggle("selected", Number(button.dataset.rating) <= currentRating);
      button.setAttribute("aria-checked", String(Number(button.dataset.rating) === currentRating));
    });
  }
  async function trackTitleEvent(item, eventType) {
    if (!supabaseClient || !item?.id) return;
    try {
      const {error} = await supabaseClient.from("catalogo_eventos").upsert({app_id:String(item.id), visitor_id:visitorId, tipo_evento:eventType}, {onConflict:"app_id,visitor_id,tipo_evento", ignoreDuplicates:true});
      if (error) console.warn("Não foi possível registrar evento", error.message);
      await loadTitleCommunity(item);
    } catch (error) { console.warn(error); }
  }
  async function loadTitleCommunity(item) {
    const comments = $("#commentsList"); if (!comments || !item?.id) return;
    if (!supabaseClient) { comments.innerHTML = '<p class="form-hint">Avaliações e estatísticas aparecem quando o Supabase está conectado e as tabelas de comunidade foram criadas.</p>'; return; }
    try {
      const [feedbackResult, eventsResult, myResult] = await Promise.all([
        supabaseClient.from("catalogo_feedback").select("visitor_id,avaliacao,comentario,criado_em").eq("app_id",String(item.id)).order("criado_em",{ascending:false}).limit(50),
        supabaseClient.from("catalogo_eventos").select("visitor_id,tipo_evento").eq("app_id",String(item.id)),
        supabaseClient.from("catalogo_feedback").select("avaliacao,comentario").eq("app_id",String(item.id)).eq("visitor_id",visitorId).maybeSingle()
      ]);
      if (feedbackResult.error) throw feedbackResult.error;
      if (eventsResult.error) throw eventsResult.error;
      const feedback = feedbackResult.data || [], events = eventsResult.data || [];
      const ratings = feedback.filter(x => Number(x.avaliacao) > 0).map(x => Number(x.avaliacao));
      $("#detailRatingAverage").textContent = ratings.length ? (ratings.reduce((a,b)=>a+b,0)/ratings.length).toFixed(1)+" ★" : "—";
      $("#detailClickCount").textContent = new Set(events.filter(x=>x.tipo_evento==="click").map(x=>x.visitor_id)).size;
      $("#detailCompletionCount").textContent = new Set(events.filter(x=>x.tipo_evento==="completed").map(x=>x.visitor_id)).size;
      if (myResult.data) { currentRating = Number(myResult.data.avaliacao)||0; $("#commentText").value = myResult.data.comentario || ""; renderRatingStars(); }
      comments.innerHTML = feedback.filter(x => String(x.comentario||"").trim()).length ? feedback.filter(x => String(x.comentario||"").trim()).map(x=>`<article class="comment-card"><div class="comment-head"><strong>${escapeHTML(x.visitor_id===visitorId?"Você":"Usuário LumiPlay")}</strong><span>${x.avaliacao ? "★".repeat(Number(x.avaliacao))+"☆".repeat(5-Number(x.avaliacao)) : "Sem nota"}</span></div><p>${escapeHTML(x.comentario)}</p><small>${x.criado_em ? new Date(x.criado_em).toLocaleDateString("pt-BR") : ""}</small></article>`).join("") : '<p class="form-hint">Ainda não há comentários. Seja o primeiro a comentar.</p>';
    } catch (error) { comments.innerHTML = '<p class="form-hint">Não foi possível carregar a comunidade. Execute o SQL de migração incluído no ZIP e confira as permissões do Supabase.</p>'; console.warn(error); }
  }
  async function saveTitleFeedback(event) {
    event.preventDefault(); const item = findItem(selectedItemId); if (!item || !supabaseClient) { showToast("Conecte o Supabase para publicar avaliações e comentários."); return; }
    const comment = $("#commentText").value.trim(); if (!currentRating && !comment) { showToast("Escolha uma nota ou escreva um comentário."); return; }
    const payload = {app_id:String(item.id), visitor_id:visitorId, avaliacao:currentRating || null, comentario:comment};
    const {error} = await supabaseClient.from("catalogo_feedback").upsert(payload,{onConflict:"app_id,visitor_id"});
    if (error) { showToast("Não foi possível salvar: " + error.message); return; }
    showToast("Avaliação salva. Obrigado!"); await loadTitleCommunity(item); await loadCommunityRatings();
  }
  function renderEpisodes(item, seasonIndex) {
    const season = item.seasons?.[seasonIndex];
    const episodes = season?.episodes || [];
    $("#episodeList").innerHTML = episodes.length ? episodes.map((episode,index) => {
      const thumb = safePoster(episode.still || episode.poster || item.poster);
      return `<button class="episode-row" data-episode="${index}" data-season="${seasonIndex}"><span class="episode-thumb">${thumb ? `<img src="${escapeHTML(thumb)}" alt="" loading="lazy">` : `<span>${String(index+1).padStart(2,"0")}</span>`}</span><span class="episode-copy"><strong>${escapeHTML(episode.title || `Episódio ${index+1}`)}</strong><small>${escapeHTML(episode.description || "Episódio da série")}</small></span><span class="episode-play">▶</span></button>`;
    }).join("") : '<p class="form-hint">Nenhum episódio cadastrado nesta temporada.</p>';
  }
  function playItem(item, episode = null, seasonIndex = null, episodeIndex = null) {
    if (!item) return;
    const title = episode ? `${item.title} — ${episode.title || "Episódio"}` : item.title;
    const source = safeURL(episode?.video || item.video);
    const video = $("#videoPlayer"), embed = $("#embedPlayer"), placeholder = $("#videoPlaceholder");
    embed.src = "about:blank"; embed.classList.add("hidden"); video.classList.add("hidden");
    video.pause(); video.removeAttribute("src"); video.load(); placeholder.classList.remove("hidden");
    $("#playerTitle").textContent = title;
    $("#playerDescription").textContent = `${item.type}${item.year ? " · " + item.year : ""}${item.genre ? " · " + item.genre : ""} — ${episode?.description || item.description || "Sem descrição cadastrada."}`;
    // Resolve o TMDB ID tanto do campo dedicado quanto do ID interno gerado pelo catálogo.
    const tmdbMatch = String(item.id || "").match(/^tmdb-(?:tv|movie)-(\d+)$/);
    const tmdbId = String(item.tmdbId || (tmdbMatch ? tmdbMatch[1] : "")).trim();
    let embedUrl = "";
    if (/^\d+$/.test(tmdbId)) {
      if (item.type === "Série") {
        // MegaEmbed usa TMDB + temporada + episódio; numeração começa em 1.
        const selectedSeason = seasonIndex !== null ? item.seasons?.[Number(seasonIndex)] : null;
        const selectedEpisode = selectedSeason && episodeIndex !== null ? selectedSeason.episodes?.[Number(episodeIndex)] : null;
        const seasonNumber = Number(selectedEpisode?.seasonNumber ?? selectedSeason?.seasonNumber ?? (seasonIndex !== null ? Number(seasonIndex) + 1 : 1));
        const episodeNumber = Number(selectedEpisode?.episodeNumber ?? (episodeIndex !== null ? Number(episodeIndex) + 1 : 1));
        embedUrl = `https://mgeb.site/embed/${encodeURIComponent(tmdbId)}/${seasonNumber}/${episodeNumber}`;
      } else {
        // O endpoint documentado do MegaEmbed usa o ID TMDB como parâmetro.
        embedUrl = `https://mgeb.site/embed/${encodeURIComponent(tmdbId)}`;
      }
    }
    if (embedUrl) {
      embed.src = embedUrl;
      embed.setAttribute("allow", "autoplay; fullscreen; picture-in-picture; encrypted-media");
      embed.setAttribute("allowfullscreen", "");
      embed.setAttribute("referrerpolicy", "no-referrer");
      embed.classList.remove("hidden"); placeholder.classList.add("hidden");
      $("#playerSourceNote").textContent = "Player MegaEmbed (mgeb.site), usando os endpoints documentados de TMDB. O serviço indica dublado como padrão; idioma e disponibilidade dependem das fontes externas.";
    } else if (source) {
      video.classList.remove("hidden"); video.src = source; placeholder.classList.add("hidden");
      $("#playerSourceNote").textContent = "Se o vídeo não iniciar, confirme se o endereço é direto e permite reprodução no navegador.";
      video.load();
      const progressKey = episode ? `${item.id}:s${Number(episode.seasonNumber ?? (seasonIndex !== null ? Number(seasonIndex)+1 : 1))}:e${Number(episode.episodeNumber ?? (episodeIndex !== null ? Number(episodeIndex)+1 : 1))}` : item.id;
      video.onloadedmetadata = () => { if (progress[progressKey]?.time && progress[progressKey].time < video.duration - 10) video.currentTime = progress[progressKey].time; };
      video.ontimeupdate = () => {
        if (video.duration && Number.isFinite(video.duration)) {
          progress[progressKey] = {time:video.currentTime,duration:video.duration,title:item.title,episode:episode?.title || "",updated:Date.now()}; saveProgress();
          if (!progress[progressKey].completedTracked && video.duration - video.currentTime <= 1200) { progress[progressKey].completedTracked = true; saveProgress(); trackTitleEvent(item, "completed"); }
        }
      };
      video.onended = () => { if (!progress[progressKey]?.completedTracked) trackTitleEvent(item, "completed"); delete progress[progressKey]; saveProgress(); renderContinue(); };
    } else {
      $("#playerSourceNote").textContent = "Este título não tem ID TMDB válido nem fonte de vídeo direta cadastrada.";
    }
    recordWatch(item, episode, seasonIndex, episodeIndex);
    closeModal("details");
    openModal("player");
  }
  function renderContinue() {
    const entries = Object.entries(progress).filter(([key,value]) => value && value.duration && value.time > 2 && value.time < value.duration - 10).sort((a,b) => (b[1].updated||0)-(a[1].updated||0)).slice(0,10);
    $("#continueGrid").innerHTML = entries.map(([key,value]) => {
      const item = findItem(key.split(":")[0]);
      if (!item) return "";
      return `<article class="title-card" tabindex="0" role="button" aria-label="Continuar ${escapeHTML(item.title)}" data-id="${escapeHTML(item.id)}"><div class="poster" style="--poster-glow:${escapeHTML(item.color || "#7654ce")}">${safePoster(item.poster) ? `<img src="${escapeHTML(safePoster(item.poster))}" alt="" loading="lazy" onerror="this.remove()">` : ""}<span class="poster-title">${escapeHTML(item.title)}</span><span class="progress-track"><span style="width:${Math.max(0,Math.min(100,value.time/value.duration*100))}%"></span></span></div><div class="card-meta"><h3>${escapeHTML(item.title)}</h3><p>${value.episode ? escapeHTML(value.episode) + " · " : ""}Continuar assistindo</p></div></article>`;
    }).join("");
    $("#continueSection").classList.toggle("hidden", entries.length === 0);
  }
  let historyFilter = "Tudo";
  function showWatchHistory() {
    $("#catalogSection").classList.add("hidden");
    $("#continueSection").classList.add("hidden");
    $("#myListSection").classList.add("hidden");
    $("#liveTvSection")?.classList.add("hidden");
    $("#watchHistorySection").classList.remove("hidden");
    document.querySelectorAll(".nav-link").forEach(button => button.classList.toggle("active", (button.id === "watchHistoryNav" || button.id === "mobileWatchHistoryNav")));
    renderWatchHistory();
    $("#watchHistorySection").scrollIntoView({behavior:"smooth",block:"start"});
  }
  function renderWatchHistory() {
    const grid = $("#watchHistoryGrid");
    if (!grid) return;
    const query = ($("#historySearch")?.value || "").trim().toLocaleLowerCase("pt-BR");
    const entries = watchHistory.filter(entry => (historyFilter === "Tudo" || entry.type === historyFilter) && (!query || `${entry.title} ${entry.episode||""}`.toLocaleLowerCase("pt-BR").includes(query)));
    grid.innerHTML = entries.map(entry => {
      const item = findItem(entry.id);
      if (!item) return "";
      const label = entry.episode ? `${entry.episode}${entry.season ? ` · T${entry.season}` : ""}${entry.episodeNumber ? ` E${entry.episodeNumber}` : ""}` : "Filme";
      return `<article class="title-card" tabindex="0" role="button" aria-label="Abrir ${escapeHTML(item.title)}" data-id="${escapeHTML(item.id)}"><div class="poster" style="--poster-glow:${escapeHTML(item.color||"#7654ce")}">${safePoster(item.poster) ? `<img src="${escapeHTML(safePoster(item.poster))}" alt="" loading="lazy" onerror="this.remove()">` : ""}<span class="poster-tag">${escapeHTML(item.type)}</span><span class="poster-title">${escapeHTML(item.title)}</span></div><div class="card-meta"><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(label)} · ${new Date(entry.watchedAt).toLocaleDateString("pt-BR")}</p></div></article>`;
    }).join("");
    $("#watchHistoryEmpty").classList.toggle("hidden", entries.length > 0);
  }
  function showMyList() {
    $("#catalogSection").classList.add("hidden");
    $("#continueSection").classList.add("hidden");
    $("#watchHistorySection").classList.add("hidden");
    $("#liveTvSection")?.classList.add("hidden");
    $("#myListSection").classList.remove("hidden");
    $("#myListGrid").innerHTML = catalog.filter(item => isFavorite(item.id)).map(cardMarkup).join("");
    $("#myListEmpty").classList.toggle("hidden", catalog.some(item => isFavorite(item.id)));
    document.querySelectorAll(".nav-link").forEach(button => button.classList.toggle("active", (button.id === "myListNav" || button.id === "mobileMyListNav")));
    $("#myListSection").scrollIntoView({behavior:"smooth",block:"start"});
  }
  function renderMyList() {
    if (!$("#myListSection").classList.contains("hidden")) {
      $("#myListGrid").innerHTML = catalog.filter(item => isFavorite(item.id)).map(cardMarkup).join("");
      $("#myListEmpty").classList.toggle("hidden", catalog.some(item => isFavorite(item.id)));
    }
  }
  function renderAdminList() {
    $("#adminList").innerHTML = catalog.length ? catalog.map(item => `<div class="admin-item"><label class="preserve-check" title="Marque para preservar ao excluir em massa"><input type="checkbox" data-preserve="${escapeHTML(item.id)}" ${preservedIds.has(String(item.id))?"checked":""}> Preservar</label><div class="admin-thumb"></div><div class="admin-item-text"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.type)} · ${escapeHTML(item.year || "Ano não informado")}</span></div><button class="edit-button" data-edit="${escapeHTML(item.id)}" type="button">Editar</button><button class="delete-button" data-delete="${escapeHTML(item.id)}">Excluir</button></div>`).join("") : '<p class="form-hint">Nenhum título cadastrado.</p>';
    const all = catalog.length > 0 && catalog.every(item=>preservedIds.has(String(item.id)));
    if ($("#preserveSelectAll")) $("#preserveSelectAll").checked = all;
  }
  function readSeasonBuilder() {
    const list = $("#seasonEditorList");
    if (!list) return [];
    return [...list.querySelectorAll("[data-season-card]")].map((card, si) => ({
      name: card.querySelector("[data-season-name]")?.value.trim() || `Temporada ${si + 1}`,
      episodes: [...card.querySelectorAll("[data-episode-card]")].map((ep, ei) => ({
        title: ep.querySelector("[data-episode-title]")?.value.trim() || `Episódio ${ei + 1}`,
        description: ep.querySelector("[data-episode-description]")?.value.trim() || ""
      }))
    }));
  }
  function syncSeasonBuilder() {
    const field = $("#titleForm [name='seasons']");
    if (field) field.value = JSON.stringify(readSeasonBuilder(), null, 2);
  }
  function addEpisodeCard(container, episode = {}) {
    const index = container.querySelectorAll("[data-episode-card]").length + 1;
    const card = document.createElement("div");
    card.className = "episode-card";
    card.dataset.episodeCard = "1";
    card.innerHTML = `<div class="episode-card-head"><strong>Episódio ${index}</strong><button class="button button-ghost" type="button" data-remove-episode>Remover</button></div>
      <div class="episode-grid"><label>Nome do episódio<input data-episode-title maxlength="120" placeholder="Preencha automaticamente pelo TMDB"></label>
      <label>Descrição (opcional)<textarea data-episode-description rows="2" maxlength="500" placeholder="Sinopse automática pelo TMDB"></textarea></label>
      <label>ID do episódio no TMDB (opcional)<input data-episode-tmdb-id inputmode="numeric" pattern="[0-9]*" placeholder="Preenchido automaticamente"></label></div>
      <button class="button button-ghost" type="button" data-fetch-episode>✨ Buscar nome, descrição e ID no TMDB</button>`;
    card.querySelector("[data-episode-title]").value = episode.title || "";
    card.querySelector("[data-episode-description]").value = episode.description || "";
    card.querySelector("[data-episode-tmdb-id]").value = episode.tmdbEpisodeId || episode.tmdb_episode_id || "";
    card.querySelector("[data-fetch-episode]").addEventListener("click", async () => {
      const form = $("#titleForm"); const tmdbId = String(form.elements.tmdbId.value || "").trim();
      const seasonCard = container.closest("[data-season-card]");
      const seasonNumber = [...$("#seasonEditorList").querySelectorAll("[data-season-card]")].indexOf(seasonCard) + 1;
      const episodeNumber = [...container.querySelectorAll("[data-episode-card]")].indexOf(card) + 1;
      if (!tmdbCredential) { showToast("Conecte o TMDB pelo botão ☁ antes de buscar dados."); openTmdbSettings(); return; }
      if (!/^\d+$/.test(tmdbId)) { showToast("Preencha primeiro o ID TMDB da série."); return; }
      const button = card.querySelector("[data-fetch-episode]"); button.disabled = true; button.textContent = "Buscando no TMDB…";
      try {
        const data = await tmdbRequest(`tv/${encodeURIComponent(tmdbId)}/season/${seasonNumber}/episode/${episodeNumber}`);
        card.querySelector("[data-episode-title]").value = data.name || `Episódio ${episodeNumber}`;
        card.querySelector("[data-episode-description]").value = data.overview || "";
        card.querySelector("[data-episode-tmdb-id]").value = data.id ? String(data.id) : "";
        syncSeasonBuilder(); showToast(data.name ? "Dados do episódio preenchidos!" : "Episódio encontrado; sem sinopse disponível.");
      } catch (error) { showToast(error.message || "Falha ao buscar episódio."); }
      finally { button.disabled = false; button.textContent = "✨ Buscar nome, descrição e ID no TMDB"; }
    });
    container.appendChild(card);
  }
  function addSeasonCard(season = {}) {
    const list = $("#seasonEditorList");
    if (!list) return;
    const index = list.querySelectorAll("[data-season-card]").length + 1;
    const card = document.createElement("section");
    card.className = "season-card";
    card.dataset.seasonCard = "1";
    card.innerHTML = `<div class="season-card-head"><strong>Temporada ${index}</strong><button class="button button-ghost" type="button" data-remove-season>Remover temporada</button></div>
      <label>Nome da temporada<input data-season-name maxlength="80" placeholder="Temporada ${index}"></label>
      <div data-episodes></div>
      <button class="button button-ghost" type="button" data-add-episode>＋ Adicionar episódio</button>`;
    card.querySelector("[data-season-name]").value = season.name || `Temporada ${index}`;
    const episodes = card.querySelector("[data-episodes]");
    (Array.isArray(season.episodes) ? season.episodes : []).forEach(ep => addEpisodeCard(episodes, ep));
    if (!season.episodes?.length) addEpisodeCard(episodes);
    card.querySelector("[data-add-episode]").addEventListener("click", () => { addEpisodeCard(episodes); syncSeasonBuilder(); });
    card.querySelector("[data-remove-season]").addEventListener("click", () => { card.remove(); syncSeasonBuilder(); });
    card.addEventListener("input", syncSeasonBuilder);
    card.addEventListener("click", event => {
      if (event.target.closest("[data-remove-episode]")) { event.target.closest("[data-episode-card]")?.remove(); syncSeasonBuilder(); }
    });
    list.appendChild(card);
    syncSeasonBuilder();
  }
  function loadSeasonBuilder(seasons = []) {
    const list = $("#seasonEditorList");
    if (!list) return;
    list.innerHTML = "";
    (Array.isArray(seasons) ? seasons : []).forEach(addSeasonCard);
    syncSeasonBuilder();
  }
  function startEdit(item) {
    $("#titleForm [name=\"tmdbId\"]").value = item?.tmdbId ? String(item.tmdbId) : "";
    if (!item) return; const form=$("#titleForm");
    form.elements.editId.value=String(item.id); form.elements.title.value=item.title||""; form.elements.type.value=item.type||"Filme"; form.elements.genre.value=item.genre||""; form.elements.year.value=item.year||""; form.elements.poster.value=item.poster||""; form.elements.description.value=item.description||""; form.elements.video.value=item.video||""; form.elements.seasons.value=item.seasons?.length?JSON.stringify(item.seasons,null,2):""; loadSeasonBuilder(item.seasons || []);
    $("#titleSubmit").textContent="Salvar alterações"; $("#cancelEdit").classList.remove("hidden"); form.scrollIntoView({behavior:"smooth",block:"start"});
  }
  function cancelEdit() { const form=$("#titleForm"); form.reset(); form.elements.editId.value=""; loadSeasonBuilder([]); $("#titleSubmit").textContent="＋ Adicionar título"; $("#cancelEdit").classList.add("hidden"); }
  async function deleteAllExceptPreserved() {
    if (adminSession?.user?.id !== ADMIN_UID) { showToast("Entre como administrador para excluir em massa."); return; }
    const doomed = catalog.filter(item => !preservedIds.has(String(item.id)));
    if (!doomed.length) { showToast("Todos os títulos estão marcados para preservar."); return; }
    if (!confirm(`ATENÇÃO: serão excluídos ${doomed.length} títulos não selecionados. Os títulos marcados serão preservados. Esta ação não pode ser desfeita. Continuar?`)) return;
    const button = $("#deleteExceptPreserved");
    const originalText = button.textContent;
    button.disabled = true; button.textContent = "Excluindo 0/" + doomed.length + "…";
    const failed = [];
    try {
      for (let i = 0; i < doomed.length; i++) {
        button.textContent = `Excluindo ${i+1}/${doomed.length}…`;
        const ok = await deleteItemFromCloud(doomed[i]);
        if (!ok) failed.push(doomed[i]);
      }
      const failedIds = new Set(failed.map(item => String(item.id)));
      catalog = catalog.filter(item => preservedIds.has(String(item.id)) || failedIds.has(String(item.id)));
      favorites = favorites.filter(id => catalog.some(item => String(item.id) === String(id)));
      Object.keys(progress).forEach(key => { if (!catalog.some(item => String(item.id) === String(key.split(":")[0]))) delete progress[key]; });
      saveCatalog(); saveFavorites(); saveProgress(); renderCatalog(); renderAdminList();
      if (failed.length) showToast(`${doomed.length-failed.length} excluídos; ${failed.length} falharam. Veja o erro do Supabase e confira as permissões RLS.`);
      else showToast(`Exclusão concluída: ${doomed.length} título(s) removido(s).`);
    } catch (error) {
      console.error(error); showToast("A exclusão foi interrompida: " + error.message);
    } finally { button.disabled = false; button.textContent = originalText; }
  }
  function openAdmin() { renderAdminList(); openModal("admin"); refreshAdminState(); }

  const tmdbGenres = {28:"Ação",12:"Aventura",16:"Animação",35:"Comédia",80:"Crime",99:"Documentário",18:"Drama",10751:"Família",14:"Fantasia",36:"História",27:"Terror",10402:"Música",9648:"Mistério",10749:"Romance",878:"Ficção científica",10770:"Cinema TV",53:"Suspense",10752:"Guerra",37:"Faroeste",10759:"Ação",10762:"Infantil",10763:"Notícias",10764:"Reality",10765:"Ficção científica",10766:"Novela",10767:"Talk show",10768:"Guerra e política"};
  function tmdbImage(path) { return path ? "https://image.tmdb.org/t/p/w500" + path : ""; }
  function tmdbAuthHeaders() { return tmdbCredential.includes(".") ? {Authorization:"Bearer " + tmdbCredential, accept:"application/json"} : {accept:"application/json"}; }
  function tmdbUrl(path, params={}) {
    const url = new URL("https://api.themoviedb.org/3/" + path);
    Object.entries({language:"pt-BR",...params}).forEach(([key,value]) => { if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value); });
    if (!tmdbCredential.includes(".")) url.searchParams.set("api_key", tmdbCredential);
    return url.toString();
  }
  async function tmdbRequest(path, params={}) {
    const response = await fetch(tmdbUrl(path, params), {headers:tmdbAuthHeaders()});
    if (!response.ok) {
      if (response.status === 401) throw new Error("Chave/token inválido. Confira as credenciais do TMDB.");
      if (response.status === 429) throw new Error("O TMDB recebeu muitas solicitações. Aguarde um pouco e tente novamente.");
      throw new Error("Não foi possível consultar o TMDB (HTTP " + response.status + ").");
    }
    return response.json();
  }
  function normalizeTmdb(raw) {
    const isTV = raw.media_type === "tv" || (!!raw.name && !raw.title);
    if (!isTV && !raw.title) return null;
    const type = isTV ? "Série" : "Filme";
    const title = isTV ? raw.name : raw.title;
    const date = isTV ? raw.first_air_date : raw.release_date;
    const genres = Array.isArray(raw.genre_ids) ? [...new Set(raw.genre_ids.map(id => tmdbGenres[id]).filter(Boolean))] : [];
    const id = "tmdb-" + (isTV ? "tv-" : "movie-") + raw.id;
    return {id,title,type,genre:genres.join(" • ") || (isTV ? "Série" : "Filme"),year:date ? date.slice(0,4) : "",description:raw.overview || "Sinopse ainda não disponível em português.",poster:tmdbImage(raw.poster_path),backdrop:raw.backdrop_path ? "https://image.tmdb.org/t/p/w1280"+raw.backdrop_path : "",video:"",color:"#6650a4",seasons:[],tmdbId:raw.id,tmdbMediaType:isTV?"tv":"movie",voteAverage:raw.vote_average||0};
  }
  function mergeTmdbResults(results) {
    let added = 0;
    for (const raw of (results || [])) {
      const item = normalizeTmdb(raw);
      if (!item || !/^\d+$/.test(String(item.tmdbId || ""))) continue;
      const identity = tmdbIdentity(item);
      const index = catalog.findIndex(entry => entry.id === item.id || (identity && tmdbIdentity(entry) === identity));
      if (index >= 0) {
        const existing = catalog[index];
        catalog[index] = {...existing, ...item, id:existing.id || item.id,
          video:existing.video || "", seasons:existing.seasons?.length ? existing.seasons : [],
          dbId:existing.dbId || undefined};
      } else {
        catalog.push(item);
        added++;
      }
    }
    catalog = dedupeCatalog(catalog);
    saveCatalog();
    renderCatalog();
    return added;
  }
  async function searchTmdb(term) {
    if (!tmdbCredential || term.length < 2) return;
    $("#catalogStatus").textContent = "Buscando filmes e séries no TMDB…";
    try {
      const cacheKey = `search:${term.trim().toLocaleLowerCase("pt-BR")}`;
      let data = cacheGet(cacheKey);
      if (!data) {
        data = await tmdbRequest("search/multi", {query:term,include_adult:"false",page:1});
        cacheSet(cacheKey, data);
      }
      const filtered = (data.results || []).filter(item => item.media_type === "movie" || item.media_type === "tv");
      const added = mergeTmdbResults(filtered);
      $("#catalogStatus").textContent = `${filtered.length} resultado(s) encontrados online${added ? ` · ${added} novo(s) adicionado(s) ao catálogo` : ""}.`;
      renderCatalog();
    } catch (error) { $("#catalogStatus").textContent = error.message; }
  }
  async function loadPopularTitles(reset=false) {
    if (!tmdbCredential || discoveryLoading) return;
    discoveryLoading = true;
    const button = $("#loadMoreTitles"); button.classList.remove("hidden"); button.disabled = true; button.textContent = "Carregando…";
    if (reset) discoveryPage = 1;
    try {
      const discoveryCacheKey = `trending:week:${discoveryPage}`;
      let data = cacheGet(discoveryCacheKey);
      if (!data || Date.now() - (tmdbCache[discoveryCacheKey]?.savedAt || 0) > DISCOVERY_CACHE_TTL) {
        data = await tmdbRequest("trending/all/week", {page:discoveryPage});
        cacheSet(discoveryCacheKey, data);
      }
      const results = (data.results || []).filter(item => item.media_type === "movie" || item.media_type === "tv");
      mergeTmdbResults(results);
      discoveryHasMore = discoveryPage < (data.total_pages || 1);
      discoveryPage++;
      button.classList.toggle("hidden", !discoveryHasMore);
      button.textContent = "Carregar mais títulos";
      $("#catalogStatus").textContent = `Catálogo online atualizado: ${results.length} títulos populares carregados nesta página.`;
    } catch (error) { $("#catalogStatus").textContent = error.message; button.textContent = "Tentar carregar novamente"; button.classList.remove("hidden"); }
    finally { discoveryLoading = false; button.disabled = false; }
  }
  function updateBulkProgress(done, total, message) {
    const bar = $("#bulkProgressBar"), text = $("#bulkProgressText");
    if (bar) bar.style.width = Math.max(0, Math.min(100, total ? done / total * 100 : 0)) + "%";
    if (text) text.textContent = message;
  }
  function getBulkState() { return safeParse(localStorage.getItem(BULK_STATE_KEY) || "null", null); }
  function setBulkButtons(running) {
    $("#bulkStart").disabled = running; $("#bulkPause").disabled = !running;
    $("#bulkStart").textContent = running ? "Importando…" : "Iniciar importação";
  }
  function bulkRow(item) {
    const row = itemToRow(item);
    // Keep imports strictly additive: no video URLs or seasons are supplied by metadata import.
    row.video_url = ""; row.temporadas = [];
    return row;
  }
  async function runBulkImport(resume=false) {
    if (bulkImportRunning) return;
    if (!tmdbCredential) { showToast("Conecte o TMDB primeiro no botão ☁."); openTmdbSettings(); return; }
    if (!supabaseClient || !adminSession || adminSession.user?.id !== ADMIN_UID) { showToast("Entre como administrador antes de importar."); return; }
    let state = resume ? getBulkState() : null;
    if (!state) state = {target:Number($("#bulkLimit").value)||1000, priority:$("#bulkPriority").value, types:$("#bulkTypes").value, genre:$("#bulkGenre")?.value || "", stage:0, page:1, scanned:0, inserted:0, skipped:0};
    bulkImportRunning = true; bulkImportPause = false; setBulkButtons(true);
    $("#bulkResume").classList.add("hidden");
    const target = Math.min(1000, Math.max(1, Number(state.target)||1000));
    const stages = [];
    const types = state.types === "both" ? ["movie","tv"] : [state.types];
    types.forEach(type => {
      if (state.priority === "popular" || state.priority === "mixed") stages.push({type, sort:"popularity.desc"});
      if (state.priority === "rated" || state.priority === "mixed") stages.push({type, sort:"vote_average.desc", minVotes:200});
    });
    try {
      // Read existing keys in pages to avoid replacing or duplicating records.
      const existing = new Set();
      for (let from=0; ; from+=500) {
        const {data,error} = await supabaseClient.from("catalogo").select("tmdb_id,tipo,app_id").range(from, from+499);
        if (error) throw error;
        (data||[]).forEach(r => { if (r.tmdb_id) existing.add((r.tipo === "serie" ? "tv" : "movie")+":"+r.tmdb_id); if (r.app_id) existing.add(String(r.app_id)); });
        if (!data || data.length < 500) break;
      }
      while (state.stage < stages.length && state.scanned < target && !bulkImportPause) {
        const stage = stages[state.stage];
        const data = await tmdbRequest("discover/"+stage.type, {page:state.page, sort_by:stage.sort, include_adult:"false", "vote_count.gte":stage.minVotes||0, with_genres:state.genre||undefined});
        const results = data.results || [];
        if (!results.length || state.page > Math.min(Number(data.total_pages)||1, 500)) { state.stage++; state.page=1; continue; }
        const batch=[];
        for (const raw of results) {
          if (state.scanned >= target) break;
          state.scanned++;
          const normalized = normalizeTmdb({...raw, media_type:stage.type});
          if (!normalized) continue;
          const key = stage.type+":"+raw.id;
          if (existing.has(key) || existing.has(normalized.id)) { state.skipped++; continue; }
          existing.add(key); existing.add(normalized.id);
          batch.push(bulkRow(normalized));
        }
        // Insert, never upsert: existing records are not modified by this importer.
        for (let i=0;i<batch.length;i+=50) {
          const chunk=batch.slice(i,i+50);
          const {error} = await supabaseClient.from("catalogo").insert(chunk);
          if (error) {
            // Handle races safely: roll back this batch from the in-memory set and report instead of overwriting.
            throw new Error("Falha ao gravar lote no Supabase: "+error.message+". O progresso anterior foi salvo; você pode retomar.");
          }
          state.inserted += chunk.length;
        }
        state.page++;
        localStorage.setItem(BULK_STATE_KEY, JSON.stringify(state));
        updateBulkProgress(state.scanned,target,`Analisados ${state.scanned}/${target} · adicionados ${state.inserted} · duplicados ignorados ${state.skipped}. Salvando progresso…`);
        await new Promise(resolve => setTimeout(resolve, 180));
      }
      localStorage.setItem(BULK_STATE_KEY, JSON.stringify(state));
      if (bulkImportPause) {
        updateBulkProgress(state.scanned,target,`Pausado: ${state.scanned}/${target} analisados · ${state.inserted} adicionados · ${state.skipped} duplicados ignorados. Progresso salvo neste navegador.`);
        $("#bulkResume").classList.remove("hidden");
      } else {
        localStorage.removeItem(BULK_STATE_KEY);
        updateBulkProgress(state.scanned,target,`Concluído: ${state.inserted} adicionados · ${state.skipped} duplicados ignorados. Nenhum vídeo foi importado.`);
        $("#bulkResume").classList.add("hidden");
        await loadSharedCatalog(); renderCatalog(); renderAdminList(); showToast("Importação do catálogo concluída.");
      }
    } catch(error) {
      console.error("Importação em massa", error);
      const saved = getBulkState() || state; localStorage.setItem(BULK_STATE_KEY, JSON.stringify(saved));
      updateBulkProgress(saved.scanned||0, target, "Erro: "+error.message+" O progresso foi salvo; corrija o problema e toque em Retomar.");
      $("#bulkResume").classList.remove("hidden");
    } finally { bulkImportRunning=false; setBulkButtons(false); }
  }
  function openTmdbSettings() {
    $("#tmdbToken").value = tmdbCredential;
    $("#tmdbAutoLoad").checked = localStorage.getItem(TMDb_AUTO_KEY_SAFE) !== "false";
    openModal("tmdbModal");
  }
  const TMDb_AUTO_KEY_SAFE = TMDB_AUTO_KEY;
  async function connectTmdb() {
    const credential = $("#tmdbToken").value.trim();
    if (!credential) { showToast("Cole primeiro a chave ou o token do TMDB."); return; }
    tmdbCredential = credential;
    try {
      $("#tmdbSave").disabled = true; $("#tmdbSave").textContent = "Testando conexão…";
      await tmdbRequest("configuration");
      localStorage.setItem(TMDB_KEY, tmdbCredential);
      localStorage.setItem(TMDB_AUTO_KEY, $("#tmdbAutoLoad").checked ? "true" : "false");
      closeModal("tmdbModal");
      $("#catalogStatus").textContent = "Conectado ao TMDB. Preparando catálogo online…";
      showToast("TMDB conectado com sucesso.");
      if ($("#tmdbAutoLoad").checked) await loadPopularTitles(true);
      else $("#catalogStatus").textContent = "TMDB conectado. Pesquise um filme ou série pelo campo acima.";
    } catch (error) { tmdbCredential = localStorage.getItem(TMDB_KEY) || ""; showToast(error.message); }
    finally { $("#tmdbSave").disabled = false; $("#tmdbSave").textContent = "Salvar e conectar"; }
  }
  function disconnectTmdb() {
    if (!confirm("Desconectar o TMDB neste navegador? Os títulos já carregados continuarão salvos.")) return;
    tmdbCredential = ""; localStorage.removeItem(TMDB_KEY); localStorage.removeItem(TMDB_AUTO_KEY); closeModal("tmdbModal");
    $("#catalogStatus").textContent = "TMDB desconectado. Os títulos salvos continuam disponíveis."; $("#loadMoreTitles").classList.add("hidden"); showToast("TMDB desconectado.");
  }
  function openAddTitleSearch() {
    if (!tmdbCredential) { showToast("Conecte o TMDB pelo botão de nuvem antes de pesquisar títulos."); openTmdbSettings(); return; }
    cancelEdit();
    $("#addTitleSearchPanel").classList.remove("hidden");
    $("#tmdbAdminSearch").focus();
    $("#tmdbAdminResults").innerHTML = "";
    $("#tmdbAdminSearchStatus").textContent = "Digite o nome de um filme ou série para pesquisar no TMDB.";
  }
  async function searchTmdbForAdmin() {
    const term = $("#tmdbAdminSearch").value.trim();
    if (term.length < 2) { $("#tmdbAdminSearchStatus").textContent = "Digite pelo menos 2 caracteres."; return; }
    if (!tmdbCredential) { showToast("Conecte o TMDB primeiro."); return; }
    const button = $("#tmdbAdminSearchButton"); button.disabled = true; button.textContent = "Pesquisando…";
    $("#tmdbAdminSearchStatus").textContent = "Consultando filmes e séries no TMDB…";
    try {
      const data = await tmdbRequest("search/multi", {query:term, include_adult:"false", page:1});
      const results = (data.results || []).filter(raw => raw.media_type === "movie" || raw.media_type === "tv").slice(0,12);
      $("#tmdbAdminResults").innerHTML = results.length ? results.map(raw => {
        const item = normalizeTmdb(raw); if (!item) return "";
        const exists = catalog.some(entry => String(entry.tmdbId||"") === String(item.tmdbId) && entry.type === item.type);
        return `<button class="tmdb-admin-result" type="button" data-tmdb-add="${escapeHTML(item.id)}" data-tmdb-title="${escapeHTML(item.title)}"><span class="tmdb-admin-poster">${item.poster ? `<img src="${escapeHTML(item.poster)}" alt="" loading="lazy">` : ""}</span><span class="tmdb-admin-copy"><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(item.type)} · ${escapeHTML(item.year || "Ano desconhecido")}</small><small>${escapeHTML(item.genre)}</small>${exists ? '<em>Já cadastrado — será selecionado para edição</em>' : ""}</span><span class="tmdb-admin-plus">${exists ? "Editar" : "+ Adicionar"}</span></button>`;
      }).join("") : '<p class="form-hint">Nenhum filme ou série encontrado. Tente outro nome.</p>';
      $("#tmdbAdminSearchStatus").textContent = `${results.length} resultado(s). Escolha o título correto.`;
    } catch (error) { $("#tmdbAdminSearchStatus").textContent = error.message; }
    finally { button.disabled = false; button.textContent = "Pesquisar"; }
  }
  async function addTmdbResultToCatalog(id) {
    const item = catalog.find(entry => String(entry.id) === String(id));
    if (item) { $("#addTitleSearchPanel").classList.add("hidden"); startEdit(item); showToast("Esse título já existe. Edite os dados e adicione a URL MP4."); return; }
    const resultId = String(id).match(/^tmdb-(tv|movie)-(\d+)$/);
    if (!resultId) return;
    const type = resultId[1] === "tv" ? "Série" : "Filme";
    const tmdbId = Number(resultId[2]);
    const raw = (await tmdbRequest(`${type === "Série" ? "tv" : "movie"}/${tmdbId}`));
    const genre = Array.isArray(raw.genres) ? raw.genres.map(g=>g.name).join(" • ") : "";
    const title = type === "Série" ? raw.name : raw.title;
    const date = type === "Série" ? raw.first_air_date : raw.release_date;
    const normalized = {id:String(id), title:title||"Sem título", type, genre, year:date?date.slice(0,4):"", description:raw.overview||"Sinopse ainda não disponível.", poster:tmdbImage(raw.poster_path), video:"", color:"#6650a4", seasons:[], tmdbId};
    if (catalog.some(entry => String(entry.tmdbId||"") === String(tmdbId) && entry.type === type)) {
      const existing = catalog.find(entry => String(entry.tmdbId||"") === String(tmdbId) && entry.type === type);
      $("#addTitleSearchPanel").classList.add("hidden"); startEdit(existing); showToast("Este título já está cadastrado. Você pode adicionar a URL MP4 na edição."); return;
    }
    if (adminSession?.user?.id !== ADMIN_UID) { showToast("Entre como administrador para adicionar ao catálogo compartilhado."); return; }
    const button = document.querySelector(`[data-tmdb-add="${CSS.escape(id)}"]`); if (button) { button.disabled = true; }
    const {data:existingRows,error:lookupError} = await supabaseClient.from("catalogo").select("id,app_id").eq("tmdb_id", tmdbId).eq("tipo", type === "Série" ? "serie" : "filme").limit(1);
    if (lookupError) { showToast("Erro ao verificar duplicados: " + lookupError.message); if(button)button.disabled=false; return; }
    if (existingRows?.length) { await loadSharedCatalog(); const found=catalog.find(entry=>String(entry.tmdbId||"")===String(tmdbId)&&entry.type===type); $("#addTitleSearchPanel").classList.add("hidden"); if(found)startEdit(found); showToast("O título já existia no banco. Abra a edição para informar a URL MP4."); return; }
    const {error} = await supabaseClient.from("catalogo").insert(itemToRow(normalized));
    if (error) { showToast("Não foi possível adicionar: " + error.message); if(button)button.disabled=false; return; }
    catalog.unshift(normalized); saveCatalog(); renderCatalog(); renderAdminList();
    $("#addTitleSearchPanel").classList.add("hidden"); startEdit(normalized);
    showToast("Título adicionado. Agora cole a URL direta do MP4 e salve as alterações.");
  }

  function addTitle(event) {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form);
    const title = String(data.get("title") || "").trim();
    if (!title) { showToast("Informe o título."); return; }
    const poster = safeURL(String(data.get("poster") || "").trim());
    const video = safeURL(String(data.get("video") || "").trim());
    const yearRaw = String(data.get("year") || "").trim();
    const type = data.get("type") === "Série" ? "Série" : "Filme";
    const tmdbIdRaw = String(data.get("tmdbId") || "").trim();
    if (tmdbIdRaw && !/^\d+$/.test(tmdbIdRaw)) { showToast("O ID TMDB deve conter somente números."); return; }
    let seasons = [];
    const seasonsText = String(data.get("seasons") || "").trim();
    if (type === "Série" && seasonsText) {
      try {
        const parsed = JSON.parse(seasonsText);
        if (!Array.isArray(parsed)) throw new Error("O JSON precisa ser uma lista de temporadas.");
        seasons = parsed.map((season,si) => ({
          name: String(season.name || `Temporada ${si+1}`),
          episodes: Array.isArray(season.episodes) ? season.episodes.map((episode,ei) => ({
            title: String(episode.title || `Episódio ${ei+1}`),
            description: String(episode.description || ""),
            video: safeURL(String(episode.video || ""))
          })) : []
        }));
      } catch (error) { showToast("JSON de temporadas inválido. Confira os colchetes, aspas e vírgulas."); return; }
    }
    const editId=String(data.get("editId")||""); const existing=editId?findItem(editId):null;
    const item = {id:existing?existing.id:"local-"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),dbId:existing?.dbId,title,type,genre:String(data.get("genre")||"").trim(),year:/^\d{4}$/.test(yearRaw)?yearRaw:"",description:String(data.get("description")||"").trim(),poster,video,color:existing?.color||["#6650a4","#287b91","#a35b65","#9a713f","#3d6b77","#9b6599"][catalog.length%6],seasons,tmdbId:tmdbIdRaw || existing?.tmdbId || undefined};
    if (existing) catalog=catalog.map(entry=>entry.id===existing.id?item:entry); else catalog.unshift(item);
    if (saveCatalog()) {
      cancelEdit(); renderCatalog(); renderAdminList();
      if (adminSession?.user?.id === ADMIN_UID) {
        saveItemToCloud(item).then(ok => { if (ok) showToast(existing?"Alterações salvas no catálogo compartilhado.":"Título salvo no catálogo compartilhado."); });
      } else showToast(existing?"Título editado apenas neste navegador. Entre como administrador para sincronizar.":"Título salvo apenas neste navegador. Entre como administrador para sincronizar.");
    }
  }
  function exportCatalog() {
    const blob = new Blob([JSON.stringify(catalog,null,2)],{type:"application/json"});
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href=url; a.download="lumiplay-catalogo.json"; a.click(); URL.revokeObjectURL(url);
    showToast("Exportação iniciada.");
  }


  // TV ao Vivo: cache local + sincronização compartilhada pelo Supabase.
  const TV_CHANNELS_KEY = "lumiplay.tv-channels.v1";
  let tvChannels = safeParse(localStorage.getItem(TV_CHANNELS_KEY) || "[]", []);
  if (!Array.isArray(tvChannels)) tvChannels = [];
  let tvCloudReady = false;
  let tvCloudLoadPromise = null;
  let editingTvId = null;
  function saveTvChannelsLocal() {
    try { localStorage.setItem(TV_CHANNELS_KEY, JSON.stringify(tvChannels)); } catch (e) { console.warn("Não foi possível salvar o cache local dos canais", e); }
  }
  async function saveTvChannels(options = {}) {
    saveTvChannelsLocal();
    renderTvChannels();
    if (options.cloud === false) return true;
    if (!supabaseClient) { showToast("Canais salvos apenas neste aparelho: Supabase indisponível."); return false; }
    if (adminSession?.user?.id !== ADMIN_UID) { showToast("Entre como administrador para sincronizar canais com a TV."); return false; }
    const rows = tvChannels.map(c => ({ id: String(c.id), name: String(c.name), category: String(c.category || "Outros"), url: String(c.url), logo: String(c.logo || ""), updated_at: new Date().toISOString() }));
    const { error: deleteError } = await supabaseClient.from("tv_channels").delete().neq("id", "__never_match__");
    if (deleteError) { console.error("Falha ao limpar canais remotos", deleteError); showToast("Não foi possível sincronizar canais: " + deleteError.message); return false; }
    if (rows.length) {
      const { error } = await supabaseClient.from("tv_channels").upsert(rows, { onConflict: "id" });
      if (error) { console.error("Falha ao sincronizar canais", error); showToast("Falha ao sincronizar canais: " + error.message); return false; }
    }
    tvCloudReady = true;
    showToast("Canais sincronizados. Eles já podem aparecer na TV após atualizar.");
    return true;
  }
  async function loadTvChannelsFromCloud() {
    if (tvCloudLoadPromise) return tvCloudLoadPromise;
    tvCloudLoadPromise = (async () => {
      if (!supabaseClient) return false;
      const { data, error } = await supabaseClient.from("tv_channels").select("id,name,category,url,logo,updated_at").order("name", { ascending: true });
      if (error) {
        console.warn("Canais compartilhados não carregaram", error);
        const note = error.code === "42P01" || error.code === "PGRST205" ? " Execute o arquivo supabase-tv-channels.sql no SQL Editor do Supabase." : error.message;
        if (tvChannels.length) showToast("TV ao Vivo ainda está local neste aparelho." + note);
        return false;
      }
      const remote = (data || []).map(c => ({ id: String(c.id), name: String(c.name || ""), category: String(c.category || "Outros"), url: normalizeEmbedInput(c.url), logo: String(c.logo || "") })).filter(c => c.name && validHttpsUrl(c.url));
      // Preserve channels already stored on the admin device so they can be migrated to the shared table.
      const byUrl = new Map(remote.map(c => [c.url, c]));
      for (const c of tvChannels) if (c?.name && validHttpsUrl(c.url) && !byUrl.has(c.url)) byUrl.set(c.url, c);
      const hadLocalOnly = byUrl.size > remote.length;
      tvChannels = [...byUrl.values()];
      saveTvChannelsLocal(); renderTvChannels(); tvCloudReady = true;
      if (hadLocalOnly && adminSession?.user?.id === ADMIN_UID) await saveTvChannels();
      return true;
    })();
    try { return await tvCloudLoadPromise; } finally { tvCloudLoadPromise = null; }
  }
  function normalizeEmbedInput(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    // Aceita tanto URL direta quanto o iframe copiado do site de embeds.
    if (/<iframe\b/i.test(raw)) {
      const srcMatch = raw.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
      if (!srcMatch) return "";
      try { return new URL(srcMatch[2], location.href).href; } catch (_) { return ""; }
    }
    return raw;
  }
  function validHttpsUrl(value) { try { const u = new URL(String(value || "")); return u.protocol === "https:" && !!u.hostname; } catch (_) { return false; } }
  function showTvSection() {
    ["catalogSection","continueSection","watchHistorySection","myListSection"].forEach(id => $("#"+id)?.classList.add("hidden"));
    $("#liveTvSection").classList.remove("hidden");
    document.querySelectorAll(".nav-link").forEach(button => button.classList.toggle("active", button.hasAttribute("data-tv-nav")));
    renderTvChannels(); $("#liveTvSection").scrollIntoView({behavior:"smooth",block:"start"});
  }
  function renderTvChannels() {
    const grid=$("#tvChannelGrid"); if(!grid) return;
    const query=($("#tvSearch")?.value||"").trim().toLocaleLowerCase("pt-BR");
    const chosen=$("#tvCategory")?.value||"Tudo";
    const cats=[...new Set(tvChannels.map(c=>String(c.category||"Outros")).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"pt-BR"));
    const select=$("#tvCategory"); if(select){ const prior=chosen; select.innerHTML='<option value="Tudo">Todas</option>'+cats.map(c=>`<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join(""); select.value=cats.includes(prior)?prior:"Tudo"; }
    const filtered=tvChannels.filter(c=>(chosen==="Tudo"||String(c.category||"Outros")===chosen)&&(!query||`${c.name} ${c.category||""}`.toLocaleLowerCase("pt-BR").includes(query)));
    grid.innerHTML=filtered.map(c=>`<button class="tv-channel-card" type="button" data-tv-play="${escapeHTML(c.id)}"><div class="tv-channel-logo">${validHttpsUrl(c.logo)?`<img src="${escapeHTML(c.logo)}" alt="" loading="lazy" onerror="this.remove()">`:''}<span class="tv-channel-fallback">${escapeHTML((c.name||"TV").slice(0,22))}</span></div><div class="tv-channel-copy"><span class="tv-live-tag">● AO VIVO</span><strong>${escapeHTML(c.name)}</strong><span>${escapeHTML(c.category||"Outros")}</span></div></button>`).join("");
    $("#tvEmpty").classList.toggle("hidden",filtered.length>0);
  }
  function openTvChannel(id) {
    const c=tvChannels.find(item=>String(item.id)===String(id)); if(!c)return;
    if(!validHttpsUrl(c.url)){showToast("URL inválida. Use um endereço HTTPS autorizado.");return;}
    $("#tvEmbedFrame").src=c.url; $("#tvPlayerTitle").textContent=c.name; $("#tvPlayerNote").textContent=`${c.category||"Outros"} · Transmissão externa. Se não carregar, o provedor pode bloquear incorporação.`;
    openModal("tvPlayer");
  }
  function openTvForm() { editingTvId=null; $("#tvChannelForm").reset(); $("#tvModalTitle").textContent="Adicionar canal"; openModal("tvChannel"); }
  async function exportTvJson() { if (adminSession?.user?.id !== ADMIN_UID) { showToast("Entre como administrador para exportar os canais."); return; } await loadTvChannelsFromCloud(); const blob=new Blob([JSON.stringify(tvChannels,null,2)],{type:"application/json"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="lumiplay-canais-tv.json"; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); showToast("Exportação dos canais iniciada."); }
  function importTvJson(file) {
    if(!file)return;
    if (adminSession?.user?.id !== ADMIN_UID) { showToast("Entre como administrador para importar canais."); return; }
    const reader=new FileReader(); reader.onload=async()=>{try{const data=JSON.parse(reader.result);if(!Array.isArray(data))throw new Error("O JSON deve conter uma lista de canais.");const valid=data.map(c=>({id:String(c.id||crypto.randomUUID()),name:String(c.name||c.nome||"").trim(),category:String(c.category||c.categoria||"Outros").trim()||"Outros",url:normalizeEmbedInput(c.url||c.embed||c.embed_url||""),logo:String(c.logo||c.logo_url||"").trim()})).filter(c=>c.name&&validHttpsUrl(c.url));if(!valid.length)throw new Error("Nenhum canal válido. Cada item precisa de name e URL HTTPS em url/embed.");const byUrl=new Map(tvChannels.map(c=>[c.url,c]));valid.forEach(c=>byUrl.set(c.url,c));tvChannels=[...byUrl.values()];await saveTvChannels();showToast(`${valid.length} canal(is) importado(s).`);}catch(e){showToast("Falha na importação: "+e.message);}};reader.readAsText(file);
  }

  document.addEventListener("click", event => {
    const tvNav = event.target.closest("[data-tv-nav]"); if (tvNav) showTvSection();
    const tvCard = event.target.closest("[data-tv-play]"); if (tvCard) openTvChannel(tvCard.dataset.tvPlay);
    const filterButton = event.target.closest("[data-filter]");
    if (filterButton) setFilter(filterButton.dataset.filter);
    const card = event.target.closest(".title-card");
    if (card) openDetails(findItem(card.dataset.id));
    const closeButton = event.target.closest("[data-close]");
    if (closeButton) { if(closeButton.dataset.close === "tvPlayer") $("#tvEmbedFrame").src="about:blank"; closeModal(closeButton.dataset.close); }
    const editButton = event.target.closest("[data-edit]");
    if (editButton) startEdit(findItem(editButton.dataset.edit));
    const preserveBox = event.target.closest("[data-preserve]");
    if (preserveBox) { if (preserveBox.checked) preservedIds.add(String(preserveBox.dataset.preserve)); else preservedIds.delete(String(preserveBox.dataset.preserve)); const allBox=$("#preserveSelectAll"); if(allBox) allBox.checked=catalog.length>0&&catalog.every(item=>preservedIds.has(String(item.id))); }
    const deleteButton = event.target.closest("[data-delete]");
    if (deleteButton) {
      const item = findItem(deleteButton.dataset.delete);
      if (item && confirm(`Excluir "${item.title}" do catálogo compartilhado?`)) {
        if (adminSession?.user?.id !== ADMIN_UID) { showToast("Entre como administrador para excluir títulos do catálogo compartilhado."); return; }
        deleteButton.disabled = true; deleteButton.textContent = "Excluindo…";
        deleteItemFromCloud(item).then(ok => {
          if (!ok) { deleteButton.disabled = false; deleteButton.textContent = "Excluir"; return; }
          catalog = catalog.filter(entry => String(entry.id) !== String(item.id));
          favorites = favorites.filter(id => String(id) !== String(item.id));
          Object.keys(progress).filter(key => key.startsWith(String(item.id))).forEach(key => delete progress[key]);
          preservedIds.delete(String(item.id));
          saveCatalog(); saveFavorites(); saveProgress(); renderCatalog(); renderAdminList();
          showToast("Título excluído do catálogo compartilhado.");
        }).catch(error => { console.error(error); deleteButton.disabled = false; deleteButton.textContent = "Excluir"; showToast("Não foi possível excluir: " + error.message); });
      }
    }
    const episodeButton = event.target.closest("[data-episode]");
    if (episodeButton) {
      const item = findItem(selectedItemId);
      const season = item?.seasons?.[Number(episodeButton.dataset.season)];
      const episode = season?.episodes?.[Number(episodeButton.dataset.episode)];
      if (item && episode) playItem(item, episode, Number(episodeButton.dataset.season), Number(episodeButton.dataset.episode));
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") document.querySelectorAll(".modal:not(.hidden)").forEach(modal => closeModal(modal.id));
    if ((event.key === "Enter" || event.key === " ") && event.target.classList.contains("title-card")) { event.preventDefault(); event.target.click(); }
  });
  $("#searchInput").addEventListener("input", () => {
    renderCatalog();
    clearTimeout(searchTimer);
    const term = $("#searchInput").value.trim();
    if (tmdbCredential && term.length >= 2) searchTimer = setTimeout(() => searchTmdb(term), 450);
    else if (!term && tmdbCredential) $("#catalogStatus").textContent = "Catálogo online conectado · pesquise para encontrar mais títulos.";
  });
  $("#genreFilter").addEventListener("change", renderCatalog);
  $("#bulkStart")?.addEventListener("click", () => runBulkImport(false));
  $("#bulkPause")?.addEventListener("click", () => { bulkImportPause = true; $("#bulkPause").disabled = true; });
  $("#bulkResume")?.addEventListener("click", () => runBulkImport(true));
  const savedBulkState = getBulkState();
  if (savedBulkState) { $("#bulkResume")?.classList.remove("hidden"); updateBulkProgress(savedBulkState.scanned||0, savedBulkState.target||1000, `Importação interrompida: ${savedBulkState.scanned||0}/${savedBulkState.target||1000} analisados. Toque em Retomar para continuar.`); }
  $("#tmdbOpen").addEventListener("click", openTmdbSettings);
  $("#tmdbSave").addEventListener("click", connectTmdb);
  $("#tmdbDisconnect").addEventListener("click", disconnectTmdb);
  $("#loadMoreTitles").addEventListener("click", () => loadPopularTitles(false));
  $("#adminOpen").addEventListener("click", openAdmin);
  $("#bannerAdmin").addEventListener("click", openAdmin);
  $("#resetCatalog").addEventListener("click", () => {
    if (adminSession?.user?.id !== ADMIN_UID) { showToast("Entre como administrador para restaurar exemplos."); return; }
    if (confirm("Restaurar os títulos de exemplo? Isso apagará os títulos cadastrados localmente e não excluirá automaticamente o catálogo remoto.")) {
      catalog=starterCatalog.map(item=>({...item,seasons:item.seasons||[]})); favorites=[]; progress={};
      saveCatalog(); saveFavorites(); saveProgress(); renderCatalog(); renderAdminList(); showToast("Catálogo de exemplo restaurado.");
    }
  });
  $("#heroPlay").addEventListener("click", () => $("#catalogSection").scrollIntoView({behavior:"smooth"}));
  $("#heroInfo").addEventListener("click", () => openModal("info"));
  $("#myListNav").addEventListener("click", showMyList);
  $("#mobileMyListNav")?.addEventListener("click", showMyList);
  $("#watchHistoryNav")?.addEventListener("click", showWatchHistory);
  $("#mobileWatchHistoryNav")?.addEventListener("click", showWatchHistory);
  $("#historySearch")?.addEventListener("input", renderWatchHistory);
  document.querySelectorAll("[data-history-filter]").forEach(button => button.addEventListener("click", () => {
    historyFilter = button.dataset.historyFilter;
    document.querySelectorAll("[data-history-filter]").forEach(b => b.classList.toggle("active", b === button));
    renderWatchHistory();
  }));
  $("#clearWatchHistory")?.addEventListener("click", () => {
    if (!confirm("Limpar o histórico de filmes e séries assistidos neste navegador?")) return;
    watchHistory = []; saveWatchHistory(); renderWatchHistory(); showToast("Histórico limpo.");
  });
  $("#backToCatalog").addEventListener("click", () => { $("#myListSection").classList.add("hidden"); $("#catalogSection").classList.remove("hidden"); $("#continueSection").classList.toggle("hidden", Object.keys(progress).length===0); setFilter("Tudo"); $("#catalogSection").scrollIntoView({behavior:"smooth"}); });
  $("#detailsPlay").addEventListener("click", () => playItem(findItem(selectedItemId)));
  $("#detailsFavorite").addEventListener("click", () => {
    if (!selectedItemId) return;
    if (isFavorite(selectedItemId)) favorites=favorites.filter(id=>id!==selectedItemId); else favorites.push(selectedItemId);
    saveFavorites(); $("#detailsFavorite").textContent=isFavorite(selectedItemId)?"♥ Remover da minha lista":"♡ Adicionar à minha lista";
    renderCatalog(); renderMyList(); showToast(isFavorite(selectedItemId)?"Adicionado à minha lista.":"Removido da minha lista.");
  });
  $("#seasonSelect").addEventListener("change", () => {
    const item=findItem(selectedItemId); if(item) renderEpisodes(item,Number($("#seasonSelect").value));
  });
  $("#addSeasonButton")?.addEventListener("click", () => addSeasonCard());
  $("#syncSeasonsButton")?.addEventListener("click", () => { syncSeasonBuilder(); showToast("Temporadas e episódios atualizados."); });
  $("#titleForm").addEventListener("submit", addTitle);
  $("#adminAddTitle").addEventListener("click", openAddTitleSearch);
  $("#tmdbAdminSearchButton").addEventListener("click", searchTmdbForAdmin);
  $("#tmdbAdminSearch").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); searchTmdbForAdmin(); } });
  $("#tmdbAdminResults").addEventListener("click", event => { const result=event.target.closest("[data-tmdb-add]"); if(result) addTmdbResultToCatalog(result.dataset.tmdbAdd).catch(error=>{console.error(error);showToast("Erro ao adicionar título: "+error.message);}); });
  $("#cancelTmdbAdminSearch").addEventListener("click", () => $("#addTitleSearchPanel").classList.add("hidden"));
  $("#cancelEdit").addEventListener("click", cancelEdit);
  $("#deleteExceptPreserved").addEventListener("click", deleteAllExceptPreserved);
  $("#preserveSelectAll").addEventListener("change", event => { preservedIds.clear(); if(event.target.checked) catalog.forEach(item=>preservedIds.add(String(item.id))); renderAdminList(); });
  document.querySelectorAll("#ratingInput [data-rating]").forEach(button=>button.addEventListener("click",()=>{currentRating=Number(button.dataset.rating);renderRatingStars();}));
  $("#commentForm").addEventListener("submit", saveTitleFeedback);
  $("#adminLogin").addEventListener("click", loginAdmin);
  $("#adminLogout").addEventListener("click", async () => { if (supabaseClient) await supabaseClient.auth.signOut(); adminSession = null; await refreshAdminState(); setBackendStatus("Você saiu do painel administrativo."); showToast("Sessão encerrada."); });
  $("#exportCatalog").addEventListener("click", exportCatalog);
  $("#addTvChannel")?.addEventListener("click", openTvForm);
  $("#tvSearch")?.addEventListener("input", renderTvChannels);
  $("#tvCategory")?.addEventListener("change", renderTvChannels);
  $("#exportTvChannels")?.addEventListener("click", exportTvJson);
  $("#tvFullscreenButton")?.addEventListener("click", async () => { const wrap=$(".tv-embed-wrap"); const frame=$("#tvEmbedFrame"); try { if(document.fullscreenElement){ await document.exitFullscreen(); } else if(wrap?.requestFullscreen){ await wrap.requestFullscreen(); } else { window.open(frame.src, "_blank", "noopener"); } } catch (_) { window.open(frame.src, "_blank", "noopener"); } });
  $("#importTvChannels")?.addEventListener("click",()=>$("#tvImportFile").click());
  $("#tvImportFile")?.addEventListener("change",event=>{importTvJson(event.target.files?.[0]);event.target.value="";});
  $("#tvChannelForm")?.addEventListener("submit",async event=>{event.preventDefault();const name=$("#tvName").value.trim(),category=$("#tvGenre").value.trim()||"Outros",url=normalizeEmbedInput($("#tvUrl").value),logo=$("#tvLogo").value.trim();if(adminSession?.user?.id!==ADMIN_UID){showToast("Entre como administrador para cadastrar canais compartilhados.");return;}if(!name||!validHttpsUrl(url)||(logo&&!validHttpsUrl(logo))){showToast("Informe o nome e uma URL HTTPS válida ou cole o iframe completo.");return;}const existing=tvChannels.find(c=>c.url===url);if(existing){showToast("Este endereço já está cadastrado.");return;}tvChannels.push({id:crypto.randomUUID?crypto.randomUUID():String(Date.now()),name,category,url,logo});const ok=await saveTvChannels();if(ok){closeModal("tvChannel");} });
  $("#year").textContent=new Date().getFullYear();
  renderCatalog();
  renderTvChannels();
  loadTvChannelsFromCloud();
  loadSharedCatalog();
  loadCommunityRatings();
  refreshAdminState();
  if (tmdbCredential) {
    $("#loadMoreTitles").classList.remove("hidden");
    $("#catalogStatus").textContent = "TMDB configurado neste navegador. Pesquise títulos ou carregue mais populares.";
    if (localStorage.getItem(TMDb_AUTO_KEY_SAFE) !== "false") loadPopularTitles(true);
  }
})();
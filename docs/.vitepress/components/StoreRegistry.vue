<template>
  <div class="mioku-store">
    <div class="store-toolbar">
      <div class="store-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          :class="['store-tab', { active: activeType === tab.key }]"
          @click="changeType(tab.key)"
        >
          {{ tab.label }}
        </button>
      </div>

      <div class="store-search-wrap">
        <input
          v-model.trim="searchQuery"
          class="store-search"
          placeholder="搜索包名或描述..."
        />
        <button
          v-if="searchQuery"
          class="store-search-clear"
          type="button"
          aria-label="清除搜索"
          @click="clearSearch"
        >
          ×
        </button>
      </div>
    </div>

    <div v-if="loading" class="store-loading">
      <div class="store-spinner"></div>
      <span>正在加载...</span>
    </div>

    <div v-else-if="error" class="store-error">
      {{ error }}
    </div>

    <template v-else>
      <p class="store-summary">
        {{ total }} 个结果
        <template v-if="searchQuery"> · 搜索：{{ searchQuery }}</template>
      </p>

      <div class="store-grid">
        <div
          v-for="item in items"
          :key="item.npm"
          class="store-card"
        >
          <div class="store-card-top">
            <h3 class="store-card-name">{{ item.name }}</h3>
            <div class="store-badges">
              <span class="store-badge store-badge--type">
                {{ typeLabel(item.type) }}
              </span>
              <span v-if="item.builtin" class="store-badge store-badge--builtin">内置</span>
              <span v-else-if="item.official" class="store-badge store-badge--official">官方</span>
              <span v-else class="store-badge store-badge--community">社区</span>
            </div>
          </div>

          <p class="store-card-desc">{{ item.description || '暂无描述' }}</p>

          <div class="store-card-footer">
            <span class="store-card-meta">
              <span v-if="item.version" class="store-card-version">v{{ item.version }}</span>
              <a v-if="item.repo" :href="toBrowserUrl(item.repo)" target="_blank" rel="noopener" class="store-card-link">仓库</a>
              <a v-if="!item.builtin" :href="item.npmUrl" target="_blank" rel="noopener" class="store-card-link">npm</a>
            </span>
          </div>
        </div>
      </div>

      <p v-if="items.length === 0" class="store-empty">
        <template v-if="searchQuery">
          没有匹配「{{ searchQuery }}」的结果
          <button class="store-empty-reset" type="button" @click="clearSearch">清除搜索</button>
        </template>
        <template v-else>暂无插件、服务或适配器</template>
      </p>

      <div v-if="totalPages > 1" class="store-pagination">
        <button class="store-page-btn" :disabled="page <= 1" @click="prevPage">上一页</button>
        <span class="store-page-info">{{ page }} / {{ totalPages }}</span>
        <button class="store-page-btn" :disabled="page >= totalPages" @click="nextPage">下一页</button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'

const PAGE_SIZE = 12
const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search'
const GITHUB_RAW = 'https://raw.githubusercontent.com/mioku-lab/mioku/main'

const tabs = [
  { key: 'all', label: '全部' },
  { key: 'plugin', label: '插件' },
  { key: 'service', label: '服务' },
  { key: 'adapter', label: '适配器' },
]

const activeType = ref('all')
const searchQuery = ref('')
const page = ref(1)
const loading = ref(true)
const error = ref('')
const allPackages = ref([])

function typeLabel(type) {
  return type === 'plugin' ? '插件' : type === 'service' ? '服务' : '适配器'
}

function inferType(name) {
  if (name.startsWith('mioku-plugin-')) return 'plugin'
  if (name.startsWith('mioku-service-')) return 'service'
  if (name.startsWith('mioku-adapter-')) return 'adapter'
  return null
}

function stripPrefix(name, type) {
  const prefix =
    type === 'plugin'
      ? 'mioku-plugin-'
      : type === 'service'
        ? 'mioku-service-'
        : 'mioku-adapter-'
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

function normalizeRepoUrl(repo) {
  if (!repo) return ''
  let raw = typeof repo === 'string' ? repo : repo?.url || ''
  if (!raw) return ''
  raw = raw.trim().replace(/^git\+/, '')
  if (raw.startsWith('git@')) {
    const m = raw.match(/^git@([^:]+):(.+)$/)
    if (m) raw = `https://${m[1]}/${m[2]}`
  }
  return raw.replace(/\.git$/, '')
}

function toBrowserUrl(raw) {
  if (!raw) return ''
  let url = raw.trim()
  if (url.startsWith('git@')) {
    const m = url.match(/^git@([^:]+):(.+)$/)
    if (m) url = `https://${m[1]}/${m[2]}`
  }
  return url.replace(/^git\+/, '').replace(/\.git$/, '')
}

async function loadStore() {
  loading.value = true
  error.value = ''
  try {
    const [officialRegistry, npmResults] = await Promise.all([
      loadOfficialRegistry(),
      loadNpmPackages(),
    ])

    allPackages.value = await mergeResults(officialRegistry, npmResults)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function loadOfficialRegistry() {
  const res = await fetch(`${GITHUB_RAW}/official-registry.json`)
  if (!res.ok) throw new Error(`加载官方仓库失败 (HTTP ${res.status})`)
  return res.json()
}

async function loadNpmPackages() {
  const url = new URL(NPM_SEARCH_URL)
  url.searchParams.set('text', 'mioku')
  url.searchParams.set('size', '200')

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`npm 搜索失败 (HTTP ${res.status})`)
  const data = await res.json()
  return data?.objects || []
}

async function fetchBuiltinPkgJson(type, key) {
  const dir =
    type === 'plugin'
      ? `plugins/${key}`
      : type === 'service'
        ? `src/services/${key}`
        : `packages/mioku-adapter-${key}`
  const res = await fetch(`${GITHUB_RAW}/${dir}/package.json`)
  if (!res.ok) return null
  return res.json()
}

async function mergeResults(officialRegistry, npmObjects) {
  const seen = new Map()
  const hidden = {
    plugin: new Set(officialRegistry.hidden?.plugins || []),
    service: new Set(officialRegistry.hidden?.services || []),
    adapter: new Set(officialRegistry.hidden?.adapters || []),
  }

  for (const obj of npmObjects) {
    const pkg = obj?.package
    if (!pkg) continue
    const name = String(pkg.name || '').trim()
    if (!name || seen.has(name)) continue

    const type = inferType(name)
    if (!type) continue

    // hidden 名单内的包不出现在市场
    if (hidden[type].has(stripPrefix(name, type))) continue

    const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.map(String) : []
    if (!keywords.includes('mioku')) continue

    seen.set(name, {
      name: stripPrefix(name, type),
      npm: name,
      type,
      description: String(pkg.description || '').trim(),
      version: String(pkg.version || '').trim(),
      keywords,
      official: false,
      builtin: false,
      repo: normalizeRepoUrl(pkg.repository),
      npmUrl: String(pkg.links?.npm || `https://www.npmjs.com/package/${name}`),
    })
  }

  const {
    plugins: officialPlugins = {},
    services: officialServices = {},
    adapters: officialAdapters = {},
  } = officialRegistry

  const builtinTasks = []

  const processEntries = (entries, type) => {
    for (const [key, entry] of Object.entries(entries)) {
      if (hidden[type].has(key)) continue
      const isBuiltin = Boolean(entry.builtin)
      const npm = isBuiltin
        ? `mioku-${type === 'plugin' ? 'plugin' : type === 'service' ? 'service' : 'adapter'}-${key}`
        : entry.npm
      if (!npm) continue

      if (seen.has(npm)) {
        const existing = seen.get(npm)
        existing.official = true
        existing.builtin = isBuiltin
      } else if (isBuiltin) {
        const base =
          type === 'plugin'
            ? `plugins/${key}`
            : type === 'service'
              ? `src/services/${key}`
              : `packages/mioku-adapter-${key}`
        seen.set(npm, {
          name: key,
          npm,
          type,
          description: '',
          version: '',
          keywords: ['mioku'],
          official: true,
          builtin: true,
          repo: `https://github.com/mioku-lab/mioku/tree/main/${base}`,
          npmUrl: `https://www.npmjs.com/package/${npm}`,
        })

        const task = fetchBuiltinPkgJson(type, key).then(pkgJson => {
          if (pkgJson) {
            const existing = seen.get(npm)
            if (existing) {
              existing.description = String(pkgJson.description || '').trim()
              existing.version = String(pkgJson.version || '').trim()
            }
          }
        })
        builtinTasks.push(task)
      }
    }
  }

  processEntries(officialPlugins, 'plugin')
  processEntries(officialServices, 'service')
  processEntries(officialAdapters, 'adapter')

  await Promise.all(builtinTasks)

  return Array.from(seen.values())
}

const filteredItems = computed(() => {
  let list = [...allPackages.value]

  if (activeType.value !== 'all') {
    list = list.filter(item => item.type === activeType.value)
  }

  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(item =>
      item.name.toLowerCase().includes(q) ||
      item.npm.toLowerCase().includes(q) ||
      (item.description && item.description.toLowerCase().includes(q)) ||
      item.keywords.some(k => k.toLowerCase().includes(q))
    )
  }

  list.sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return list
})

const items = computed(() => {
  const offset = (page.value - 1) * PAGE_SIZE
  return filteredItems.value.slice(offset, offset + PAGE_SIZE)
})

const total = computed(() => filteredItems.value.length)
const hasMore = computed(() => page.value * PAGE_SIZE < total.value)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

watch(searchQuery, () => {
  page.value = 1
})

function clearSearch() {
  searchQuery.value = ''
}

function changeType(type) {
  activeType.value = type
  page.value = 1
}

function prevPage() {
  if (page.value <= 1) return
  page.value -= 1
}

function nextPage() {
  if (!hasMore.value) return
  page.value += 1
}

onMounted(() => {
  loadStore()
})
</script>

<style scoped>
.mioku-store {
  margin-top: 0.5rem;
}

.store-toolbar {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.store-tabs {
  display: flex;
  gap: 0.25rem;
}

.store-tab {
  padding: 0.4rem 0.85rem;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.store-tab:hover {
  color: var(--vp-c-text-1);
  background: var(--vp-c-default-soft);
}

.store-tab.active {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.store-search-wrap {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 200px;
}

.store-search {
  flex: 1;
  width: 100%;
  padding: 0.5rem 2rem 0.5rem 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--vp-c-default-soft);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 0.85rem;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.store-search:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 2px var(--vp-c-brand-soft);
}

.store-search-clear {
  position: absolute;
  top: 50%;
  right: 0.5rem;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
  font-size: 0.8rem;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s ease;
}

.store-search-clear:hover {
  color: var(--vp-c-text-1);
  background: var(--vp-c-brand-soft);
}

.store-loading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 2rem;
  color: var(--vp-c-text-2);
  font-size: 0.85rem;
  justify-content: center;
}

.store-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--vp-c-default-soft);
  border-top-color: var(--vp-c-brand-1);
  border-radius: 50%;
  animation: mioku-spin 0.6s linear infinite;
}

@keyframes mioku-spin {
  to { transform: rotate(360deg); }
}

.store-error {
  padding: 0.75rem 1rem;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.08);
  color: #ef4444;
  font-size: 0.85rem;
}

.store-summary {
  margin-bottom: 0.75rem;
  color: var(--vp-c-text-3);
  font-size: 0.8rem;
}

.store-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.75rem;
}

.store-card {
  display: flex;
  flex-direction: column;
  padding: 1rem;
  border-radius: 8px;
  border: 1px solid var(--vp-c-default-soft);
  background: var(--vp-c-bg-soft);
  transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
}

.store-card:hover {
  border-color: var(--vp-c-brand-soft);
  transform: translateY(-2px);
  box-shadow: 0 10px 24px -16px rgba(0, 0, 0, 0.45);
}

.store-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.store-card-name {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
}

.store-badges {
  display: flex;
  gap: 0.3rem;
  flex-shrink: 0;
}

.store-badge {
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-size: 0.65rem;
  font-weight: 500;
}

.store-badge--type {
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
}

.store-badge--official {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.store-badge--community {
  background: rgba(56, 189, 248, 0.1);
  color: #38bdf8;
}

.store-badge--builtin {
  background: rgba(168, 85, 247, 0.1);
  color: #a855f7;
}

.store-card-desc {
  margin: 0 0 0.75rem;
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.store-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: auto;
}

.store-card-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
}

.store-card-version {
  font-family: var(--vp-font-family-mono);
}

.store-card-link {
  color: var(--vp-c-brand-1);
  text-decoration: none;
  font-weight: 500;
  transition: opacity 0.15s ease;
}

.store-card-link:hover {
  opacity: 0.8;
}

.store-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  color: var(--vp-c-text-3);
  font-size: 0.85rem;
  padding: 1.5rem 0;
  text-align: center;
}

.store-empty-reset {
  padding: 0.3rem 0.75rem;
  border: 1px solid var(--vp-c-default-soft);
  border-radius: 6px;
  background: transparent;
  color: var(--vp-c-brand-1);
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.store-empty-reset:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.store-pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1rem;
}

.store-page-btn {
  padding: 0.4rem 0.75rem;
  border: 1px solid var(--vp-c-default-soft);
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.store-page-btn:hover {
  border-color: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}

.store-page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.store-page-info {
  font-size: 0.8rem;
  color: var(--vp-c-text-3);
}
</style>

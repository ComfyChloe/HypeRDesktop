<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import HeartWidget from './components/HeartWidget.vue'
import { shouldResize, stripWidth, STRIP_HEIGHT } from './lib/layout'

// The Rust side emits TrackerSnapshot[] — an ordered array of { id, ...entry }
// — so config.json order is preserved end-to-end. Iterating a plain array
// (rather than Object.keys on a Record) gives us a deterministic render
// order across runs.
interface TrackerSnapshot {
  id: string
  name: string
  lastUpdate: number
  lastHeartrate: number
  lastChanged: number
}

const trackers = ref<TrackerSnapshot[]>([])
const shiftHeld = ref(false)
const opacityValue = ref(8)
const addId = ref('')
const addName = ref('')

const opacityClass = computed(() => `opacity-${opacityValue.value}`)
const hasTrackers = computed(() => trackers.value.length > 0)

let unlisten: UnlistenFn | null = null
let lastResizedCount = -1

async function resizeTo(count: number) {
  // Heart-rate snapshots arrive several times a second, so resize only when
  // the tracker count actually changes. Sizing rules live in `lib/layout.ts`.
  if (!shouldResize(lastResizedCount, count)) return
  lastResizedCount = count
  await invoke('resize_window', { width: stripWidth(count), height: STRIP_HEIGHT })
}

async function updateTrackers(data: TrackerSnapshot[]) {
  trackers.value = data
  await resizeTo(data.length)
}

onMounted(async () => {
  // Seed from Rust immediately so known trackers render on first paint,
  // before any WS message arrives.
  try {
    const initial = await invoke<TrackerSnapshot[]>('get_trackers')
    await updateTrackers(initial)
  } catch (e) {
    console.error('get_trackers failed:', e)
  }

  unlisten = await listen<TrackerSnapshot[]>('heart-rate-update', (event) => {
    updateTrackers(event.payload)
  })
})

onUnmounted(() => {
  unlisten?.()
})

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Shift') shiftHeld.value = true
}
function onKeyUp(e: KeyboardEvent) {
  if (e.key === 'Shift') shiftHeld.value = false
}
function onBlur() {
  shiftHeld.value = false
}

window.addEventListener('keydown', onKeyDown)
window.addEventListener('keyup', onKeyUp)
window.addEventListener('blur', onBlur)

async function addTracker() {
  const id = addId.value.trim()
  if (!id) return
  await invoke('add_tracker', { id, name: addName.value.trim() })
  addId.value = ''
  addName.value = ''
}

async function removeTracker(id: string) {
  await invoke('remove_tracker', { id })
}

function closeWindow() {
  invoke('close_window')
}
</script>

<template>
  <div id="app" :class="{ 'force-hover': !hasTrackers }">
    <HeartWidget
      v-for="entry in trackers"
      :key="entry.id"
      :id="entry.id"
      :tracker="entry"
      :opacity-class="opacityClass"
      :shift-held="shiftHeld"
      @remove="removeTracker"
    />
  </div>

  <div class="panel controlls">
    <div class="button" @click="closeWindow">✕</div>
    <div class="button" data-tauri-drag-region></div>
    <input type="range" min="0" max="10" v-model.number="opacityValue" />
  </div>

  <div class="panel add-tracker">
    <input class="input" type="text" v-model="addId" placeholder="ID" @keydown.enter="addTracker" />
    <input class="input" type="text" v-model="addName" placeholder="Name" @keydown.enter="addTracker" />
    <div class="button" @click="addTracker">✚</div>
  </div>
</template>

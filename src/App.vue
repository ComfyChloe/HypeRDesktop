<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import HeartWidget from './components/HeartWidget.vue'

interface TrackerEntry {
  name: string
  lastUpdate: number
  lastHeartrate: number
  lastChanged: number
}

const trackers = ref<Record<string, TrackerEntry>>({})
const shiftHeld = ref(false)
const opacityValue = ref(8)
const addId = ref('')
const addName = ref('')

const opacityClass = computed(() => `opacity-${opacityValue.value}`)
const trackerIds = computed(() => Object.keys(trackers.value))
const hasTrackers = computed(() => trackerIds.value.length > 0)

let unlisten: UnlistenFn | null = null

async function updateTrackers(data: Record<string, TrackerEntry>) {
  trackers.value = data
  const count = Object.keys(data).length
  const width = Math.max(count * 100, 100)
  await invoke('resize_window', { width, height: 100 })
}

onMounted(async () => {
  unlisten = await listen<Record<string, TrackerEntry>>('heart-rate-update', (event) => {
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
      v-for="id in trackerIds"
      :key="id"
      :id="id"
      :tracker="trackers[id]"
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

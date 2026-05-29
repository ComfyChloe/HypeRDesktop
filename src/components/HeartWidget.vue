<script setup lang="ts">
import { computed } from 'vue'

interface TrackerEntry {
  name: string
  lastUpdate: number
  lastHeartrate: number
  lastChanged: number
}

const props = defineProps<{
  id: string
  tracker: TrackerEntry
  opacityClass: string
  shiftHeld: boolean
}>()

const emit = defineEmits<{
  remove: [id: string]
}>()

const staleMs = computed(() => Math.abs(props.tracker.lastUpdate - Date.now()))
const isStale = computed(() => staleMs.value > 30_000)
const staleText = computed(() =>
  staleMs.value < 5 * 60_000
    ? `${Math.floor(staleMs.value / 1000)}s ago`
    : 'a while ago'
)
</script>

<template>
  <div class="heart-rate">
    <div class="background" :class="opacityClass">
      <div class="heart"></div>
    </div>
    <div class="data">
      <div class="identicator">{{ tracker.name }}</div>
      <div class="heart_rate">{{ tracker.lastHeartrate || '' }}</div>
      <div class="last_update" :class="{ hidden: !isStale }">{{ staleText }}</div>
    </div>
    <div class="remove-btn" :class="{ visible: shiftHeld }" @click.stop="emit('remove', id)">✕</div>
  </div>
</template>

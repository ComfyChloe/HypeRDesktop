<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import {
  heartDisplay as computeHeartDisplay,
  isDisconnected as computeIsDisconnected,
  isStale as computeIsStale,
  staleText as computeStaleText,
  type TrackerEntry,
} from '../lib/trackerDisplay'

const props = defineProps<{
  id: string
  tracker: TrackerEntry
  opacityClass: string
  shiftHeld: boolean
}>()

const emit = defineEmits<{
  remove: [id: string]
}>()

// All four rules live in `lib/trackerDisplay.ts` so their thresholds are
// unit-tested. They are time-dependent, so a ticking clock keeps the
// widget honest without the parent re-sending a snapshot every second —
// the Rust side emits on data change only, so a stale widget would
// otherwise keep claiming to be live indefinitely.
const now = ref(Date.now())
const timer = setInterval(() => {
  now.value = Date.now()
}, 1000)
onUnmounted(() => clearInterval(timer))

const isStale = computed(() => computeIsStale(props.tracker, now.value))
const isDisconnected = computed(() => computeIsDisconnected(props.tracker, now.value))
const staleText = computed(() => computeStaleText(props.tracker, now.value))
const heartDisplay = computed(() => computeHeartDisplay(props.tracker, now.value))

// The remove button is only *visually* hidden until shift is held. Without
// this guard it stays clickable, so an ordinary click anywhere on the
// transparent widget would delete a tracker — the overlay sits over other
// windows, so stray clicks are expected rather than exceptional.
function onRemove() {
  if (!props.shiftHeld) return
  emit('remove', props.id)
}
</script>

<template>
  <div class="heart-rate" :class="{ disconnected: isDisconnected }">
    <div class="background" :class="opacityClass">
      <div class="heart"></div>
    </div>
    <div class="data">
      <div class="identicator">{{ tracker.name }}</div>
      <div class="heart_rate">{{ heartDisplay }}</div>
      <div class="last_update" :class="{ hidden: !isStale }">{{ staleText }}</div>
    </div>
    <div
      class="remove-btn"
      :class="{ visible: shiftHeld }"
      @click.stop="onRemove"
    >✕</div>
  </div>
</template>

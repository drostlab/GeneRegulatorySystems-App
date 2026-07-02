<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import PanelState from './PanelState.vue'

defineProps<{
    label: string
}>()

const showLongWaitHint = ref(false)
const hintTimer = window.setTimeout(() => {
    showLongWaitHint.value = true
}, 60_000)

onBeforeUnmount(() => window.clearTimeout(hintTimer))
</script>

<template>
    <PanelState
        kind="loading"
        variant="overlay"
        :title="label"
        :description="showLongWaitHint ? 'Still loading. If the app appears stuck, try restarting it.' : undefined"
    />
</template>

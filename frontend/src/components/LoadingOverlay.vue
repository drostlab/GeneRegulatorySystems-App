<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import ProgressSpinner from 'primevue/progressspinner'

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
    <div class="loading-overlay">
        <div class="loading-card">
            <ProgressSpinner style="width: 50px; height: 50px" stroke-width="3" />
            <div class="loading-text">{{ label }}</div>
            <div v-if="showLongWaitHint" class="long-wait-hint">
                Still loading. If the app appears stuck, try restarting it.
            </div>
        </div>
    </div>
</template>

<style scoped>
.long-wait-hint {
    max-width: 320px;
    color: var(--p-text-muted-color);
    font-size: 12px;
    text-align: center;
}
</style>

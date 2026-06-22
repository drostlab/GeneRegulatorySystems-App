<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import Button from 'primevue/button'
import SelectButton from 'primevue/selectbutton'
import { useLogStore, type LogLine } from '@/stores/logStore'
import { GREEN, PURPLE, RED } from '@/config/theme'

const store = useLogStore()
const scrollContainer = ref<HTMLDivElement>()
const filter = ref<'all' | 'backend' | 'frontend'>('all')

const filterOptions = [
    { label: 'All', value: 'all' },
    { label: 'Backend', value: 'backend' },
    { label: 'Frontend', value: 'frontend' },
]

const filteredLines = computed<LogLine[]>(() => {
    if (filter.value === 'backend') return store.backendLines
    if (filter.value === 'frontend') return store.frontendLines
    return store.lines
})

function formatTime(ts: number): string {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

// Auto-scroll to bottom when new lines arrive
watch(() => store.lines.length, async () => {
    if (!scrollContainer.value) return
    const el = scrollContainer.value
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (isNearBottom) {
        await nextTick()
        el.scrollTop = el.scrollHeight
    }
})
</script>

<template>
    <div class="log-drawer app-dark">
        <div class="log-toolbar">
            <SelectButton
                v-model="filter"
                :options="filterOptions"
                optionLabel="label"
                optionValue="value"
                :allowEmpty="false"
                size="small"
            />
            <div class="log-toolbar-right">
                <Button
                    icon="pi pi-times"
                    severity="secondary"
                    text
                    rounded
                    size="small"
                    v-grs-tooltip="'Close'"
                    @click="store.drawerVisible = false"
                />
            </div>
        </div>
        <div ref="scrollContainer" class="log-content selectable-text">
            <div
                v-for="(line, i) in filteredLines"
                :key="i"
                class="log-line"
                :class="[`log-line--${line.source}`, `log-line--${line.level}`]"
            >
                <span class="log-ts">{{ formatTime(line.timestamp) }}</span>
                <span class="log-source">{{ line.source }}</span>
                <span class="log-text">{{ line.text }}</span>
            </div>
            <div v-if="filteredLines.length === 0" class="log-empty">No log entries.</div>
        </div>
    </div>
</template>

<style scoped>
.log-drawer {
    width: 100%;
    height: 100%;
    min-height: 0;
    background: var(--p-content-background);
    display: flex;
    flex-direction: column;
    font-family: "Montserrat", sans-serif;
    font-size: var(--font-size-sm);
    color: var(--p-text-color);
}

.log-toolbar {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
    padding: var(--spacing-sm) var(--spacing-md);
    border-bottom: 1px solid var(--p-surface-200);
    flex-shrink: 0;
}

.log-toolbar-right {
    margin-left: auto;
    display: flex;
    gap: var(--spacing-xs);
}

.log-toolbar :deep(.p-togglebutton) {
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: var(--font-size-s);
}

.log-content {
    flex: 1;
    overflow-y: auto;
    padding: var(--spacing-sm) var(--spacing-md);
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: var(--font-size-xs);
}

.log-line {
    display: flex;
    gap: var(--spacing-md);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
}

.log-ts {
    color: var(--p-text-muted-color);
    flex-shrink: 0;
}

.log-source {
    color: var(--p-text-muted-color);
    flex-shrink: 0;
    min-width: 5ch;
    font-weight: 600;
}

.log-text {
    flex: 1;
    color: var(--p-text-muted-color);
}

.log-line--frontend .log-source {
    color: v-bind('PURPLE[400]');
}

.log-line--backend .log-source {
    color: v-bind('GREEN[400]');
}

.log-line--debug .log-text {
    color: var(--p-surface-400);
}

.log-line--warn .log-text,
.log-line--stderr .log-text {
    color: var(--p-yellow-400);
}

.log-line--error .log-text {
    color: v-bind('RED[400]');
}

.log-empty {
    color: var(--p-text-muted-color);
    padding: var(--spacing-xl);
    text-align: center;
    font-family: "Montserrat", sans-serif;
    font-size: var(--font-size-sm);
}

</style>

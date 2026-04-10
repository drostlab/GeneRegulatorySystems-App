<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import Button from 'primevue/button'
import SelectButton from 'primevue/selectbutton'
import { useLogStore, type LogLine } from '@/stores/logStore'

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

function levelColour(level: string): string {
    switch (level) {
        case 'error': return 'var(--p-red-400)'
        case 'warn': case 'stderr': return 'var(--p-yellow-400)'
        case 'debug': return 'var(--p-surface-400)'
        default: return 'inherit'
    }
}

function formatTime(ts: number): string {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

async function copyAll(): Promise<void> {
    await navigator.clipboard.writeText(store.formatAll())
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
    <Transition name="drawer">
        <div v-if="store.drawerVisible" class="log-drawer">
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
                        icon="pi pi-copy"
                        severity="secondary"
                        text
                        rounded
                        size="small"
                        v-grs-tooltip="'Copy all logs'"
                        @click="copyAll"
                    />
                    <Button
                        icon="pi pi-trash"
                        severity="secondary"
                        text
                        rounded
                        size="small"
                        v-grs-tooltip="'Clear logs'"
                        @click="store.clear()"
                    />
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
            <div ref="scrollContainer" class="log-content">
                <div v-for="(line, i) in filteredLines" :key="i" class="log-line">
                    <span class="log-ts">{{ formatTime(line.timestamp) }}</span>
                    <span class="log-source">{{ line.source }}</span>
                    <span class="log-text" :style="{ color: levelColour(line.level) }">{{ line.text }}</span>
                </div>
                <div v-if="filteredLines.length === 0" class="log-empty">No log entries.</div>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
.log-drawer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 280px;
    background: var(--p-surface-0);
    border-top: 1px solid var(--p-surface-200);
    display: flex;
    flex-direction: column;
    z-index: 2000;
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
}

.log-empty {
    color: var(--p-text-muted-color);
    padding: var(--spacing-xl);
    text-align: center;
    font-family: "Montserrat", sans-serif;
    font-size: var(--font-size-sm);
}

.drawer-enter-active,
.drawer-leave-active {
    transition: transform 0.2s ease;
}

.drawer-enter-from,
.drawer-leave-to {
    transform: translateY(100%);
}
</style>

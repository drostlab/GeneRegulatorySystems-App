<script setup lang="ts">
import { useScheduleStore } from '@/stores/scheduleStore'
import ScheduleView from './ScheduleView.vue'

const scheduleStore = useScheduleStore()
</script>

<template>
    <div class="schedule-viewer">
        <ScheduleView
            :segments="scheduleStore.segments"
            :each-prefixes="scheduleStore.eachPrefixes"
            :operators="scheduleStore.scheduleOperators"
        />
    </div>
</template>

<style scoped>
.schedule-viewer {
    width: 100%;
    min-width: 0;
    min-height: 0;
    padding: .5rem;
    overflow: hidden;
    background: var(--p-surface-ground);
}

.schedule-viewer :deep(.schedule-view) {
    height: 100%;
    display: flex;
    flex-direction: column;
}

.schedule-viewer :deep(.schedule-scroll) {
    flex: 1;
}
</style>

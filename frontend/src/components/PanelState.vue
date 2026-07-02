<script setup lang="ts">
import ProgressSpinner from 'primevue/progressspinner'

withDefaults(defineProps<{
    kind?: 'empty' | 'loading' | 'error' | 'hint'
    variant?: 'inline' | 'overlay'
    title: string
    description?: string
}>(), {
    kind: 'empty',
    variant: 'inline',
})
</script>

<template>
    <div class="panel-state" :class="[`panel-state--${kind}`, `panel-state--${variant}`]">
        <div class="panel-state-card">
            <ProgressSpinner
                v-if="kind === 'loading'"
                class="panel-state-spinner"
                style="width: 32px; height: 32px"
                stroke-width="3"
            />
            <div class="panel-state-title">{{ title }}</div>
            <div v-if="description" class="panel-state-description">{{ description }}</div>
            <div v-if="$slots.default" class="panel-state-actions">
                <slot />
            </div>
        </div>
    </div>
</template>

<style scoped>
.panel-state {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    min-height: 0;
    color: var(--p-text-muted-color);
    pointer-events: none;
}

.panel-state--inline {
    width: 100%;
    height: 100%;
    padding: 1.5rem;
}

.panel-state--overlay {
    position: absolute;
    inset: 0;
    z-index: 100;
    padding: 1.5rem;
    background:
        radial-gradient(circle at center, color-mix(in srgb, var(--p-primary-color) 4%, transparent), transparent 52%),
        color-mix(in srgb, var(--p-surface-ground) 88%, transparent);
    pointer-events: auto;
}

.panel-state-card {
    max-width: 360px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: .36rem;
    text-align: center;
}

.panel-state--overlay .panel-state-card {
    padding: 1rem 1.2rem;
    border: 1px solid color-mix(in srgb, var(--p-surface-border) 54%, transparent);
    border-radius: 16px;
    background: color-mix(in srgb, var(--p-content-background) 76%, transparent);
    box-shadow: 0 14px 36px color-mix(in srgb, #000 13%, transparent);
    backdrop-filter: blur(4px);
}

.panel-state--loading :deep(.p-progressspinner-circle) {
    color: var(--p-primary-color);
    stroke: var(--p-primary-color);
}

.panel-state-title {
    color: color-mix(in srgb, var(--p-text-color) 72%, transparent);
    font-size: .82rem;
    font-weight: 400;
    line-height: 1.28;
}

.panel-state--error .panel-state-title {
    color: color-mix(in srgb, var(--p-red-400, #f87171) 86%, var(--p-text-color));
}

.panel-state-description {
    color: var(--p-text-muted-color);
    font-size: .74rem;
    line-height: 1.42;
}

.panel-state-actions {
    margin-top: .35rem;
    pointer-events: auto;
}
</style>

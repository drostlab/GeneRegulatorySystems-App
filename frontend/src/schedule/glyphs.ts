export const INSTANT_ICONS: Readonly<Record<string, string>> = {
    Merge: 'pi pi-arrow-right-arrow-left',
    Filter: 'pi pi-filter',
    Pass: 'pi pi-arrow-right',
}

export function instantIcon(modelType: string): string {
    return INSTANT_ICONS[modelType] ?? 'pi pi-circle-fill'
}

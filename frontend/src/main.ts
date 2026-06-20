import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import { grsTooltip } from '@/utils/grsTooltip'
import Tooltip from 'primevue/tooltip'
import { definePreset } from '@primeuix/themes'
import 'primeicons/primeicons.css'
import './style.css'
import App from './App.vue'
import Aura from '@primeuix/themes/aura'
import { EWatermarkPosition, SciChartDefaults, SciChartSurface } from "scichart";
import { RED, GREEN} from '@/config/theme';
import { initialiseBackend, setupAppMenu } from '@/tauri'
import { installConsoleCapture } from '@/utils/consoleCapture'

SciChartSurface.UseCommunityLicense();
SciChartDefaults.watermarkPosition = EWatermarkPosition.BottomRight

SciChartDefaults.nativeFontTimeout = 10000
SciChartDefaults.canvasFontFamily = "Montserrat"
SciChartDefaults.useNativeText = false


const MyPreset = definePreset(Aura, {
    semantic: {
        primary: {
            50: RED[50],
            100: RED[100],
            200: RED[200],
            300: RED[300],
            400: RED[400],
            500: RED[500],
            600: RED[600],
            700: RED[700],
            800: RED[800],
            900: RED[900],
            950: RED[950]
        },
        success: {
            50: GREEN[50],
            100: GREEN[100],
            200: GREEN[200],
            300: GREEN[300],
            400: GREEN[400],
            500: GREEN[500],
            600: GREEN[600],
            700: GREEN[700],
            800: GREEN[800],
            900: GREEN[900],
            950: GREEN[950]
        },
    },
    components: {
        message: {
            colorScheme: {
                light: {
                    info: {
                        background: '{zinc.50}',
                        borderColor: '{zinc.200}',
                        color: '{zinc.700}'
                    }
                },
                dark: {
                    info: {
                        background: '{zinc.900}',
                        borderColor: '{zinc.600}',
                        color: '{zinc.400}'
                    }
                }
            }
        }
    }
})

const app = createApp(App)

const pinia = createPinia()
app.use(pinia)
app.use(PrimeVue, {
    theme: {
        preset: MyPreset,
        options: {
            darkModeSelector: '.app-dark'
        }
    }
})

app.directive('tooltip', Tooltip)
app.directive('grs-tooltip', grsTooltip)

// Install console capture (must be after Pinia)
installConsoleCapture()

// Initialise backend connection (Tauri: waits for Julia; browser: immediate)
initialiseBackend().then(() => {
    app.mount('#app')
    setupAppMenu()
})

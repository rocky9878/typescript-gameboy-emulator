<script setup lang="ts">
import { ChevronsRight, HardDriveDownload, HardDriveUpload, Upload, Volume2 } from '@lucide/vue';
import { onUnmounted, ref, useTemplateRef } from 'vue';
import { run, setCpuSpeed } from '@/emulator/CPU';
import type { CPU } from '@/emulator/CPU';
import type { JoypadButton } from '@/emulator/joypad';
import { SaveStateMap, User } from '@/types';
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, DropdownMenu } from '@/components/ui/dropdown-menu';
import axios from 'axios';
import { store } from '@/routes';
import { router } from '@inertiajs/vue3';
import { toast } from 'vue-sonner';

interface Props {
    user?: User;
    saveStates: SaveStateMap;
}

const props = defineProps<Props>();

const canvas = useTemplateRef<HTMLCanvasElement>('canvas');

// run() resolves once the ROM has loaded and the emulation loop has started; keeping the
// CPU instance around (rather than letting it stay local to run()) is what lets save/load
// be triggered from outside CPU.ts - e.g. UI buttons or devtools - instead of only from
// code that has direct access to the module-internal instance.
let cpu: CPU | undefined;
let disposeEmulator: (() => void) | undefined;
let unmounted = false;
let autosaveInterval = <number|undefined>undefined;
const warningShown = ref(false);
const speed = ref<1|2|3>(1);
const rom = ref<string>('');
// 'auto' follows the cartridge header; bind a UI control to override for CGB-enhanced carts.
const consoleMode = ref<'auto' | 'dmg' | 'cgb'>('auto');
const cgbActive = ref<boolean>(false);
const fileInput = useTemplateRef('romInput');
const volume = ref<number>(Number(localStorage.getItem('emulator:volume') ?? '0.5'));

function confirmExit() {
    return "Unsaved progress will be lost on page exit.";
}
window.onbeforeunload = confirmExit;

// Unsubscribe on unmount - otherwise this global listener keeps prompting on every later
// Inertia visit (e.g. the login/register submit button).
const stopBeforeNavigate = router.on('before', () => {
    return props.user ? true : confirm("Unsaved progress will be lost on page exit.");
});

onUnmounted(() => {
    unmounted = true;
    rom.value = '';
    clearInterval(autosaveInterval);
    disposeEmulator?.();
    stopBeforeNavigate();
    window.onbeforeunload = null;
});

async function saveState(): Promise<string> {
    if (!cpu) {
        throw new Error('Emulator not running yet');
    }

    return cpu.getSaveState();
}

function loadState(json: string): Promise<void> {
    if (!cpu) {
        throw new Error('Emulator not running yet');
    }

    return cpu.setSaveState(json);
}

async function onSaveClick(slot: number) {
    if(!props.user) return;
    const state = await saveState();

    axios.post(store.url(), {
        'save_data': state,
        'rom_name': rom.value,
        'slot': slot,
    }).then(() => {
        router.reload({
            only: ['saveStates']
        })
    });
}

async function onLoadClick(slot: number) {
    if (props.saveStates && props.saveStates[slot]) {
        await loadState(props.saveStates[slot].save_data);
    }
}

async function loadRom() {
    if(rom.value) return;
    const handle = await run('/Pokémon_red.gb', canvas.value ?? undefined, consoleMode.value);
    cpu = handle.cpu;
    disposeEmulator = handle.dispose;
    cgbActive.value = handle.cgb;
    cpu.setVolume(volume.value);

    rom.value = 'Pokémon_red.gb'.substring(0, 'Pokémon_red.gb'.length - 3);

    autosaveInterval = setInterval(() => {
        onSaveClick(10);
    }, 1000 * 60 * 5);

    // Navigated away before the ROM finished loading - tear down immediately.
    if (unmounted) {
        disposeEmulator();
    }
}

function onVolumeInput() {
    localStorage.setItem('emulator:volume', String(volume.value));
    cpu?.setVolume(volume.value);
}

function incrementSpeed() {
    if (!cpu) {
        throw new Error('Emulator not running yet');
    }

    if(speed.value < 3) {
        speed.value = <1|2|3>(speed.value + 1);
    } else speed.value = 1;

    setCpuSpeed(speed.value);
}

// The emulator listens for real keydown/keyup events on window (see emulator/CPU.ts's
// KEY_TO_BUTTON map). Dispatching synthetic events with the same `code` reuses that exact
// pipeline instead of duplicating the joypad-wiring logic here.
const CODE_FOR_BUTTON: Record<JoypadButton, string> = {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    a: 'KeyZ',
    b: 'KeyX',
    start: 'Enter',
    select: 'ShiftLeft',
};

function press(button: JoypadButton) {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: CODE_FOR_BUTTON[button] }));
}

function release(button: JoypadButton) {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: CODE_FOR_BUTTON[button] }));
}

function convertTZ(dateTime: string) {
    const date = new Date((typeof dateTime === "string" ? new Date(dateTime) : dateTime).toLocaleString("en-US", {timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}));
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
}

async function downloadState() {
    const state = await saveState();
    const file = new File([state], rom.value+'_State.bin');

    const link = document.createElement('a');
    link.style.display = 'none';
    link.href = URL.createObjectURL(file);
    link.download = file.name;
    link.click();

    // To make this work on Firefox we need to wait
    // a little while before removing it.
    setTimeout(() => {
        URL.revokeObjectURL(link.href);
        link.parentNode?.removeChild(link);
    }, 0);
}

function promptUpload(type: 'rom'|'state') {
    if(!fileInput.value) return;
    fileInput.value.click();
    fileInput.value.ariaLabel = type;
}

async function handleUpload(event: Event) {
    const file = (event.target as HTMLInputElement)?.files?.[0];
    if(!file) return;
    if(fileInput.value?.ariaLabel === 'state') file.text().then((value) => loadState(value));
    else {
        clearInterval(autosaveInterval);
        disposeEmulator?.();

        file.bytes().then(async (value) => {
            let handle = await run(value, canvas.value ?? undefined, consoleMode.value)
            cpu = handle.cpu;
            disposeEmulator = handle.dispose;
            cgbActive.value = handle.cgb;
            cpu.setVolume(volume.value);
        });

        rom.value = file.name;

        autosaveInterval = setInterval(() => {
            onSaveClick(10);
        }, 1000 * 60 * 5);
    }
}

function instabilityWarning() {
    if(warningShown.value) return;
    warningShown.value = true;
    toast.warning('emulating at high speeds may cause audio instability');
}

</script>

<template>
    <div class="overflow-hidden">
        <div class="flex gap-2 flex-col min-h-[calc(100vh-80px)] w-full items-center justify-center scale-110 md:scale-140">
            <div class="rounded-full flex text-violet-800 dark:text-violet-200 bg-violet-100 dark:bg-violet-950/50 ring-1 ring-violet-300 dark:ring-violet-800 shadow-sm gap-2">
                <div title="Start ROM" class="cursor-pointer flex justify-center items-center size-10 relative rounded-full">
                    <DropdownMenu>
                        <DropdownMenuTrigger class="mx-auto h-full cursor-pointer"><Upload/></DropdownMenuTrigger>
                        <DropdownMenuContent class="gap-1 max-w-screen">
                            <DropdownMenuLabel class="col-span-3 text-center">Load Rom</DropdownMenuLabel>
                            <DropdownMenuItem class="col-span-3 text-center block whitespace-nowrap" @click="loadRom()">very secret and very legal pokemon red Rom</DropdownMenuItem>
                            <DropdownMenuItem class="col-span-3 text-center block whitespace-nowrap" @click="promptUpload('rom')">Import Rom</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <div title="Load State" class="flex justify-center items-center size-10 relative rounded-full">
                    <DropdownMenu>
                        <DropdownMenuTrigger :class="{ 'pointer-events-none': !rom }"  class="mx-auto h-full cursor-pointer"><HardDriveDownload/></DropdownMenuTrigger>
                        <DropdownMenuContent class="grid grid-cols-3 gap-1 max-w-screen" v-if="rom">
                            <DropdownMenuLabel class="col-span-3 text-center">Load state</DropdownMenuLabel>
                            <DropdownMenuItem class="col-span-3 border" v-if="user">Autosave
                                <p v-if="saveStates?.[10]" class="w-full mb-1 text-right">{{ saveStates?.[10].rom_name }} - {{ convertTZ(saveStates?.[10].created_at) }}</p>
                                <p v-else class="w-full text-right">empty</p>
                            </DropdownMenuItem>
                            <DropdownMenuItem v-for="index in 9" :key="index" class="border flex justify-center align-middle text-center" v-if="user" @click="onLoadClick(index)">
                                <div v-if="saveStates?.[index]">
                                    <p class="w-full mb-1">{{ saveStates[index].rom_name }}</p>
                                    <p>{{ convertTZ(saveStates[index].created_at) }}</p>
                                </div>
                                <p v-else>empty</p>
                            </DropdownMenuItem>
                            <DropdownMenuItem class="col-span-3 text-center block whitespace-nowrap" @click="promptUpload('state')">Import from file<br/><p class="text-[8px] text-gray-400" v-if="!user">log in to save to the server</p></DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <div title="Save State" class="flex justify-center items-center size-10 relative rounded-full">
                    <DropdownMenu>
                        <DropdownMenuTrigger :class="{ 'pointer-events-none': !rom }" class="mx-auto h-full cursor-pointer"><HardDriveUpload/></DropdownMenuTrigger>
                        <DropdownMenuContent class="grid grid-cols-3 gap-1 max-w-screen" v-if="rom">
                            <DropdownMenuLabel class="col-span-3 text-center">Save state</DropdownMenuLabel>
                            <DropdownMenuItem v-for="index in 9" :key="index" class="border flex justify-center align-middle text-center" v-if="user" @click="onSaveClick(index)">
                                <div v-if="saveStates?.[index]">
                                    <p class="w-full mb-1">{{ saveStates[index].rom_name }}</p>
                                    <p>{{ convertTZ(saveStates[index].created_at) }}</p>
                                </div>
                                <p v-else>empty</p>
                            </DropdownMenuItem>
                            <DropdownMenuItem class="col-span-3 text-center block whitespace-nowrap" @click="downloadState()">Export to file<br/><p class="text-[8px] text-gray-400" v-if="!user">log in to save to the server</p></DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <div title="Emulation Speed" class="cursor-pointer flex justify-center items-center size-10 relative rounded-full" :class="{'bg-black/20': speed != 1}" @click="incrementSpeed(); instabilityWarning()"><ChevronsRight/><p class="text-[10px] top-6 left-3.5 text-gray-700 absolute">x{{ speed }}</p></div>
            </div>
            <div class="relative w-70 rounded-[34px] border-t border-white/25 bg-[radial-gradient(130%_90%_at_30%_0%,#b49fdd,#9078c6_45%,#6d54a8)] pt-5 pb-8 shadow-[0_18px_45px_rgba(0,0,0,0.35)] ring-1 ring-black/10 dark:ring-white/15 z-0">
                    <!-- Screen bezel -->
                    <div class="w-56 bg-[#2f2d38] relative rounded-md rounded-b-[22px] mx-auto pt-2.5 pb-2 px-1.5 shadow-[inset_0_1px_4px_rgba(0,0,0,0.5)]">
                        <span v-if="cgbActive" class="absolute -top-0.5 right-2 text-[7px] font-bold tracking-widest text-fuchsia-300/80 pt-2">GBC</span>
                        <canvas
                            ref="canvas"
                            width="160"
                            height="144"
                            class="mx-auto block rounded-xs bg-black [image-rendering:pixelated]"
                        ></canvas>
                        <p class="mt-1 text-center text-[8px] font-bold tracking-wide text-neutral-300">
                            GAME BOY
                            <span class="bg-[linear-gradient(to_right,#f87171,#fbbf24,#4ade80,#60a5fa,#c084fc)] bg-clip-text text-transparent italic lowercase">color</span>
                        </p>
                    </div>
                <!-- Controls -->
                <div class="mt-4 flex items-center gap-2 px-8" title="Volume">
                    <Volume2 class="size-4 text-white/55" />
                    <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        v-model.number="volume"
                        @input="onVolumeInput"
                        class="w-full accent-violet-600"
                    />
                </div>
                <div class="mt-8 flex items-start justify-between px-8">
                    <!-- D-pad -->
                    <div class="flex flex-col items-center">
                    <div class="grid h-24 w-24 grid-cols-3 grid-rows-3 select-none">
                        <div></div>
                        <button
                            aria-label="Up"
                            title="Arrow Up"
                            class="rounded-t-md bg-neutral-800 text-neutral-500 transition-colors active:bg-black active:text-neutral-300"
                            @mousedown="press('up')"
                            @mouseup="release('up')"
                            @mouseleave="release('up')"
                            @touchstart.prevent="press('up')"
                            @touchend.prevent="release('up')"
                        >
                            &#x25B2;&#xFE0E;
                        </button>
                        <div></div>

                        <button
                            aria-label="Left"
                            title="Arrow Left"
                            class="rounded-l-md bg-neutral-800 text-neutral-500 transition-colors active:bg-black active:text-neutral-300"
                            @mousedown="press('left')"
                            @mouseup="release('left')"
                            @mouseleave="release('left')"
                            @touchstart.prevent="press('left')"
                            @touchend.prevent="release('left')"
                        >
                            &#x25C0;&#xFE0E;
                        </button>
                        <div class="rounded-full bg-neutral-800"></div>
                        <button
                            aria-label="Right"
                            title="Arrow Right"
                            class="rounded-r-md bg-neutral-800 text-neutral-500 transition-colors active:bg-black active:text-neutral-300"
                            @mousedown="press('right')"
                            @mouseup="release('right')"
                            @mouseleave="release('right')"
                            @touchstart.prevent="press('right')"
                            @touchend.prevent="release('right')"
                        >
                            &#x25B6;&#xFE0E;
                        </button>

                        <div></div>
                        <button
                            aria-label="Down"
                            title="Arrow Down"
                            class="rounded-b-md bg-neutral-800 text-neutral-500 transition-colors active:bg-black active:text-neutral-300"
                            @mousedown="press('down')"
                            @mouseup="release('down')"
                            @mouseleave="release('down')"
                            @touchstart.prevent="press('down')"
                            @touchend.prevent="release('down')"
                        >
                            &#x25BC;&#xFE0E;
                        </button>
                        <div></div>
                    </div>
                    <span class="mt-1 text-center text-[7px] font-semibold tracking-wide text-white/65">ARROW KEYS</span>
                    </div>

                    <!-- A / B buttons -->
                    <div class="relative h-20 w-24 -rotate-[22deg] select-none">
                        <div class="absolute top-10 left-0 flex flex-col items-center gap-1">
                            <button
                                aria-label="B"
                                title="X"
                                class="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-b from-neutral-600 to-neutral-800 text-xs font-bold text-neutral-300 shadow-[0_3px_0_#1c1917,inset_0_2px_2px_rgba(255,255,255,0.25)] transition-transform active:translate-y-0.75 active:shadow-[0_1px_0_#1c1917]"
                                @mousedown="press('b')"
                                @mouseup="release('b')"
                                @mouseleave="release('b')"
                                @touchstart.prevent="press('b')"
                                @touchend.prevent="release('b')"
                            >
                                B
                            </button>
                            <span class="rotate-[22deg] text-[7px] font-semibold tracking-wide text-white/60">X</span>
                        </div>
                        <div class="absolute top-4 right-0 flex flex-col items-center gap-1">
                            <button
                                aria-label="A"
                                title="Z"
                                class="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-b from-neutral-600 to-neutral-800 text-xs font-bold text-neutral-300 shadow-[0_3px_0_#1c1917,inset_0_2px_2px_rgba(255,255,255,0.25)] transition-transform active:translate-y-0.75 active:shadow-[0_1px_0_#1c1917]"
                                @mousedown="press('a')"
                                @mouseup="release('a')"
                                @mouseleave="release('a')"
                                @touchstart.prevent="press('a')"
                                @touchend.prevent="release('a')"
                            >
                                A
                            </button>
                            <span class="rotate-[22deg] text-[7px] font-semibold tracking-wide text-white/60">Z</span>
                        </div>
                    </div>
                </div>

                <!-- Start / Select -->
                <div class="mt-7 flex -rotate-[22deg] justify-center gap-7 select-none">
                    <div class="flex flex-col items-center gap-1.5">
                        <button
                            aria-label="Select"
                            title="Shift"
                            class="h-2.5 w-9 rounded-full bg-gray-400 shadow-[0_2px_0_#6b7280] transition-transform active:translate-y-0.5 active:shadow-none"
                            @mousedown="press('select')"
                            @mouseup="release('select')"
                            @mouseleave="release('select')"
                            @touchstart.prevent="press('select')"
                            @touchend.prevent="release('select')"
                        ></button>
                        <span class="text-[8px] font-bold tracking-wide text-white/70">
                            SELECT <span class="font-normal text-white/40">Shift</span>
                        </span>
                    </div>
                    <div class="flex flex-col items-center gap-1.5">
                        <button
                            aria-label="Start"
                            title="Enter"
                            class="h-2.5 w-9 rounded-full bg-gray-400 shadow-[0_2px_0_#6b7280] transition-transform active:translate-y-0.5 active:shadow-none"
                            @mousedown="press('start')"
                            @mouseup="release('start')"
                            @mouseleave="release('start')"
                            @touchstart.prevent="press('start')"
                            @touchend.prevent="release('start')"
                        ></button>
                        <span class="text-[8px] font-bold tracking-wide text-white/70">
                            START <span class="font-normal text-white/40">Enter</span>
                        </span>
                    </div>
                </div>

                <!-- Speaker grille -->
                <div class="absolute right-6 bottom-6 flex -rotate-[22deg] gap-1.5">
                    <div v-for="n in 6" :key="n" class="h-6 w-1 rounded-full bg-violet-950/20"></div>
                </div>
            </div>
        </div>
    </div>
    <input type="file" ref="romInput" name="rom" hidden @change="handleUpload($event)">
</template>

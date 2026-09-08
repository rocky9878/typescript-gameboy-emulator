<script setup lang="ts">
import { ChevronsRight, HardDriveDownload, HardDriveUpload, Upload, Volume2 } from '@lucide/vue';
import { DropdownMenuContent } from 'reka-ui';
import { onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { run, setCpuSpeed } from '@/emulator/CPU';
import type { CPU } from '@/emulator/CPU';
import type { JoypadButton } from '@/emulator/joypad';
import { SaveStateMap, User } from '@/types';
import { DropdownMenuItem, DropdownMenuTrigger, DropdownMenu } from '@/components/ui/dropdown-menu';
import DropdownMenuLabel from '@/components/ui/dropdown-menu/DropdownMenuLabel.vue';
import axios from 'axios';
import { store } from '@/routes';
import { router } from '@inertiajs/vue3';

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
const speed = ref<1|2|3>(1);
const rom = ref<string>('');
const fileInput = useTemplateRef('romInput');
const volume = ref<number>(Number(localStorage.getItem('emulator:volume') ?? '0.5'));

onUnmounted(() => {
    unmounted = true;
    rom.value = '';
    clearInterval(autosaveInterval);
    disposeEmulator?.();
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
    const handle = await run('/Pokémon_red.gb', canvas.value ?? undefined);
    cpu = handle.cpu;
    disposeEmulator = handle.dispose;
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

function handleUpload(event: Event) {
    const file = (event.target as HTMLInputElement)?.files?.[0];
    if(!file) return;
    if(fileInput.value?.ariaLabel === 'state') file.text().then((value) => loadState(value));
}

</script>

<template>
    <div class="overflow-hidden">
        <div class="flex gap-2 flex-col min-h-[calc(100vh-80px)] w-full items-center justify-center md:scale-140">
            <div class="rounded-full flex text-blue-600 bg-gray-100 gap-2">
                <div title="Upload ROM" class="cursor-pointer flex justify-center items-center size-10 relative rounded-full" @click="loadRom()"><Upload/></div>
                <div title="Load State" class="flex justify-center items-center size-10 relative rounded-full">
                    <DropdownMenu>
                        <DropdownMenuTrigger :class="{ 'pointer-events-none': !rom }"  class="mx-auto h-full cursor-pointer"><HardDriveDownload/></DropdownMenuTrigger>
                        <DropdownMenuContent class="bg-white relative z-10 grid grid-cols-3 gap-1 p-1 rounded" v-if="rom">
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
                            <DropdownMenuItem class="col-span-3 text-center block whitespace-nowrap" @click="promptUpload('state')">Import from file</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <div title="Save State" class="flex justify-center items-center size-10 relative rounded-full">
                    <DropdownMenu>
                        <DropdownMenuTrigger :class="{ 'pointer-events-none': !rom }" class="mx-auto h-full cursor-pointer"><HardDriveUpload/></DropdownMenuTrigger>
                        <DropdownMenuContent class="bg-white relative z-10 grid grid-cols-3 gap-1 p-1 rounded" v-if="rom">
                            <DropdownMenuLabel class="col-span-3 text-center">Save state</DropdownMenuLabel>
                            <DropdownMenuItem v-for="index in 9" :key="index" class="border flex justify-center align-middle text-center" v-if="user" @click="onSaveClick(index)">
                                <div v-if="saveStates?.[index]">
                                    <p class="w-full mb-1">{{ saveStates[index].rom_name }}</p>
                                    <p>{{ convertTZ(saveStates[index].created_at) }}</p>
                                </div>
                                <p v-else>empty</p>
                            </DropdownMenuItem>
                            <DropdownMenuItem class="col-span-3 text-center block whitespace-nowrap" @click="downloadState()">Export to file</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <div title="Emulation Speed" class="cursor-pointer flex justify-center items-center size-10 relative rounded-full" :class="{'bg-black/20': speed != 1}" @click="incrementSpeed"><ChevronsRight/><p class="text-[10px] top-6 left-3.5 text-gray-700 absolute">x{{ speed }}</p></div>
            </div>
            <div class="relative w-70 rounded-3xl rounded-br-[72px] border-t border-white/50 bg-gray-100 pt-5 pb-8 shadow-[0_25px_60px_rgba(0,0,0,0.55)] z-0">
                    <div class="w-55 bg-gray-300 relative rounded-lg rounded-br-4xl mx-auto overflow-hidden">
                        <hr class="mx-2 mt-1 border-pink-600" />
                        <hr class="mx-2 mt-1 border-blue-600" />
                        <p class="text-[8px] text-white absolute top-px right-6.5 px-1 bg-gray-300">DOT MATRIX WITH STEREO SOUND</p>
                        <canvas
                            ref="canvas"
                            width="160"
                            height="144"
                            class="border border-gray-400 mx-auto mt-1 mb-3 block [image-rendering:pixelated]"
                        ></canvas>
                    </div>
                <!-- Controls -->
                <div class="mt-4 flex items-center gap-2 px-8" title="Volume">
                    <Volume2 class="size-4 text-gray-600" />
                    <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        v-model.number="volume"
                        @input="onVolumeInput"
                        class="w-full accent-pink-600"
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
                            ▲
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
                            ◀
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
                            ▶
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
                            ▼
                        </button>
                        <div></div>
                    </div>
                    <span class="mt-1 text-center text-[7px] font-semibold tracking-wide text-gray-400">ARROW KEYS</span>
                    </div>

                    <!-- A / B buttons -->
                    <div class="relative h-20 w-24 -rotate-[22deg] select-none">
                        <div class="absolute top-10 left-0 flex flex-col items-center gap-1">
                            <button
                                aria-label="B"
                                title="X"
                                class="flex h-10 w-10 items-center justify-center rounded-full bg-pink-600 text-xs font-bold text-pink-950/70 shadow-[0_3px_0_#9d174d,inset_0_2px_2px_rgba(255,255,255,0.3)] transition-transform active:translate-y-0.75 active:shadow-[0_1px_0_#9d174d]"
                                @mousedown="press('b')"
                                @mouseup="release('b')"
                                @mouseleave="release('b')"
                                @touchstart.prevent="press('b')"
                                @touchend.prevent="release('b')"
                            >
                                B
                            </button>
                            <span class="rotate-[22deg] text-[7px] font-semibold tracking-wide text-gray-400">X</span>
                        </div>
                        <div class="absolute top-4 right-0 flex flex-col items-center gap-1">
                            <button
                                aria-label="A"
                                title="Z"
                                class="flex h-10 w-10 items-center justify-center rounded-full bg-pink-600 text-xs font-bold text-pink-950/70 shadow-[0_3px_0_#9d174d,inset_0_2px_2px_rgba(255,255,255,0.3)] transition-transform active:translate-y-0.75 active:shadow-[0_1px_0_#9d174d]"
                                @mousedown="press('a')"
                                @mouseup="release('a')"
                                @mouseleave="release('a')"
                                @touchstart.prevent="press('a')"
                                @touchend.prevent="release('a')"
                            >
                                A
                            </button>
                            <span class="rotate-[22deg] text-[7px] font-semibold tracking-wide text-gray-400">Z</span>
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
                        <span class="text-[8px] font-bold tracking-wide text-gray-500">
                            SELECT <span class="font-normal text-gray-400">Shift</span>
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
                        <span class="text-[8px] font-bold tracking-wide text-gray-500">
                            START <span class="font-normal text-gray-400">Enter</span>
                        </span>
                    </div>
                </div>

                <!-- Speaker grille -->
                <div class="absolute right-7 bottom-6 grid -rotate-[22deg] grid-cols-5 gap-1.5">
                    <div v-for="n in 15" :key="n" class="h-1 w-1 rounded-full bg-gray-400"></div>
                </div>
            </div>
        </div>
    </div>
    <input type="file" ref="romInput" name="rom" hidden @change="handleUpload($event)">
</template>

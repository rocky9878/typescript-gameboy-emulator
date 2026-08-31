<script setup lang="ts">
import { run } from '@/emulator/CPU';
import { onMounted, useTemplateRef } from 'vue';

const canvas = useTemplateRef<HTMLCanvasElement>('canvas');

onMounted(() => {
    void run(canvas.value ?? undefined);
});
</script>

<template>
    <div class="w-full h-screen flex justify-center items-center">
        <div class="h-fit">
            <canvas ref="canvas" width="160" height="144" class="border scale-300"></canvas>
        </div>
    </div>
</template>

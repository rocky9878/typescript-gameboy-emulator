<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * A gzipped + base64-encoded save state can exceed TEXT's 64KB limit for carts with
     * large battery RAM (MBC5, up to 128KB) and grows further under CGB emulation (VRAM
     * 8->16KB, WRAM 8->32KB).
     */
    public function up(): void
    {
        Schema::table('save_states', function (Blueprint $table) {
            $table->mediumText('save_data')->change();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('save_states', function (Blueprint $table) {
            $table->text('save_data')->change();
        });
    }
};

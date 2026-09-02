<?php

use App\Models\User;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('save_states', function (Blueprint $table) {
            $table->id();
            $table->foreignIdFor(User::class);
            $table->text('save_data');
            $table->string('rom_name');
            $table->unsignedTinyInteger('slot');
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('save_states');
    }
};

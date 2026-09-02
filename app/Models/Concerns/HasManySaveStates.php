<?php

declare(strict_types=1);

namespace App\Models\Concerns;

use App\Models\SaveState;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * @template TDeclaringModel of \Illuminate\Database\Eloquent\Model
 */
trait HasManySaveStates
{
    /**
     * Get the associated posts
     *
     * @return HasMany<SaveState, $this>
     */
    public function saveStates(): HasMany
    {
        return $this->hasMany(SaveState::class);
    }
}

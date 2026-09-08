<?php

namespace App\Models;

use App\Models\Concerns\BelongsToUser;
use Carbon\Carbon;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;

/**
 * @property int $id
 * @property int $user_id
 * @property string $save_data
 * @property string $rom_name
 * @property int $slot
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 */
#[Fillable(['save_data', 'rom_name', 'slot'])]
class SaveState extends Model
{
    /** @use BelongsToUser<$this> */
    use BelongsToUser;
}

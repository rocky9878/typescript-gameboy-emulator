<?php

namespace App\Models;

use App\Models\Concerns\BelongsToUser;
use Illuminate\Database\Eloquent\Model;

class SaveState extends Model
{
    /** @use BelongsToUser<$this> */
    use BelongsToUser;
}

<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class SaveStateResource extends JsonResource
{
    /**
     * Transform the resource into an array.
     *
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'slot' => $this->slot,
            'save_data' => $this->save_data,
            'rom_name' => $this->rom_name,
            'created_at' => $this->created_at,
        ];
    }
}

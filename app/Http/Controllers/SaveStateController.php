<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreSaveStateRequest;
use App\Http\Resources\SaveStateResource;
use App\Models\SaveState;
use Illuminate\Http\Request;

class SaveStateController extends Controller
{
    /**
     * Display a listing of the resource.
     */
    public function index(Request $request)
    {
        $saveStates = $request->user()
            ?->saveStates()
            ->get()
            ->keyBy('slot')
            ->map(fn (SaveState $saveState): array => (new SaveStateResource($saveState))->toArray($request));

        return inertia('Emulator', [
            'user' => $request->user(),
            'saveStates' => $saveStates,
        ]);
    }

    /**
     * Store a newly created resource in storage.
     */
    public function store(StoreSaveStateRequest $request)
    {
        $saveState = new SaveState($request->toArray());
        $prevSave = $request->user()->saveStates()->where('slot', $request->slot)->first();
        if(isset($prevSave)) {
            $prevSave->delete();
        }

        $request->user()->saveStates()->save($saveState);
    }
}

<?php

namespace App\Http\Controllers;

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
        $saveStates = $request->user() ? SaveStateResource::make($request->user()->saveStates()) : null;

        return inertia('Emulator', ['saveStates' => $saveStates]);
    }

    /**
     * Store a newly created resource in storage.
     */
    public function store(Request $request)
    {
        //
    }
}

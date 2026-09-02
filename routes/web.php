<?php

use App\Http\Controllers\SaveStateController;
use Illuminate\Support\Facades\Route;

Route::resource('/', SaveStateController::class)->only('index', 'store');

<?php

use App\Models\User;
use Illuminate\Support\Facades\Hash;

test('security settings page is displayed', function () {
    $this->actingAs(User::factory()->create())
        ->withSession(['auth.password_confirmed_at' => time()]);

    $this->get(route('security.edit'))->assertOk();
});

test('password can be updated through fortify', function () {
    $user = User::factory()->create([
        'password' => Hash::make('current-password'),
    ]);

    $response = $this->actingAs($user)->put(route('user-password.update'), [
        'current_password' => 'current-password',
        'password' => 'new-password-123',
        'password_confirmation' => 'new-password-123',
    ]);

    $response->assertSessionHasNoErrors();
    expect(Hash::check('new-password-123', $user->fresh()->password))->toBeTrue();
});

test('current password must be correct to update password', function () {
    $user = User::factory()->create([
        'password' => Hash::make('current-password'),
    ]);

    $response = $this->actingAs($user)->put(route('user-password.update'), [
        'current_password' => 'wrong-password',
        'password' => 'new-password-123',
        'password_confirmation' => 'new-password-123',
    ]);

    $response->assertSessionHasErrors('current_password', errorBag: 'updatePassword');
    expect(Hash::check('current-password', $user->fresh()->password))->toBeTrue();
});

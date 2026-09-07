<?php

use App\Models\User;
use Illuminate\Support\Facades\Hash;

test('profile settings page is displayed', function () {
    $this->actingAs(User::factory()->create());

    $this->get(route('profile.edit'))->assertOk();
});

test('profile information can be updated through fortify', function () {
    $user = User::factory()->create();

    $response = $this->actingAs($user)->put(route('user-profile-information.update'), [
        'username' => 'updated_name',
        'email' => 'updated@example.com',
    ]);

    $response->assertSessionHasNoErrors();

    $user->refresh();
    expect($user->username)->toBe('updated_name')
        ->and($user->email)->toBe('updated@example.com');
});

test('profile update requires a valid email', function () {
    $user = User::factory()->create();

    $response = $this->actingAs($user)->put(route('user-profile-information.update'), [
        'username' => 'updated_name',
        'email' => 'not-an-email',
    ]);

    $response->assertSessionHasErrors('email', errorBag: 'updateProfileInformation');
});

test('user can delete their account', function () {
    $user = User::factory()->create([
        'password' => Hash::make('password'),
    ]);

    $response = $this->actingAs($user)->delete(route('profile.destroy'), [
        'password' => 'password',
    ]);

    $response->assertRedirect('/');
    $this->assertGuest();
    expect(User::find($user->id))->toBeNull();
});

test('account deletion requires the correct password', function () {
    $user = User::factory()->create([
        'password' => Hash::make('password'),
    ]);

    $response = $this->actingAs($user)->delete(route('profile.destroy'), [
        'password' => 'wrong-password',
    ]);

    $response->assertSessionHasErrors('password');
    expect($user->fresh())->not->toBeNull();
});

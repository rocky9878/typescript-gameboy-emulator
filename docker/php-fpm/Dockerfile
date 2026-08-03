FROM php:8.5-fpm

ARG WWWGROUP
ARG NODE_VERSION=22
ARG POSTGRES_VERSION=17

WORKDIR /var/www/html

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC
ENV SUPERVISOR_PHP_HORIZON_COMMAND="/usr/local/bin/php -d variables_order=EGPCS /var/www/html/artisan horizon"
ENV SUPERVISOR_PHP_HORIZON_LOG="/var/www/html/storage/logs/horizon.log"
ENV SUPERVISOR_PHP_USER="sail"
ENV PLAYWRIGHT_BROWSERS_PATH=0

RUN ln --force --no-dereference --symbolic /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

RUN apt-get update && apt-get install --yes git gnupg cron libcap2-bin libjpeg62-turbo-dev libpng-dev libmagickwand-dev ghostscript libzip-dev unzip supervisor \
    && apt-get autoremove --yes && apt-get clean \
    && rm --force --recursive /var/lib/apt/lists/* \
    && curl --silent --location --show-error https://getcomposer.org/installer | php -- --install-dir=/usr/bin/ --filename=composer \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_VERSION.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && npm i @rollup/rollup-linux-arm64-gnu \
    && npx playwright@latest install-deps \
    && docker-php-ext-configure gd --with-jpeg \
    && docker-php-ext-install pcntl sockets pdo_mysql exif gd zip intl \
    && pecl install redis \
    && docker-php-ext-enable redis

RUN setcap "cap_net_bind_service=+ep" /usr/local/bin/php

RUN groupadd --force -g $WWWGROUP sail
RUN useradd -ms /bin/bash --no-user-group -g $WWWGROUP -u 1337 sail

RUN echo "* * * * * root /usr/local/bin/php /var/www/html/artisan schedule:run >> /dev/null 2>&1" >> /etc/cron.d/gameboy \
    && chmod 0644 /etc/cron.d/gameboy

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

COPY start-container /usr/local/bin/start-container
COPY php.ini /usr/local/etc/php/conf.d/99-sail.ini
RUN chmod +x /usr/local/bin/start-container

EXPOSE 9000

ENTRYPOINT ["start-container"]

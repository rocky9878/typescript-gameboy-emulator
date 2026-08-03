#!/usr/bin/env bash

/usr/bin/mariadb --user=root --password="$MYSQL_ROOT_PASSWORD" <<-EOSQL
    CREATE DATABASE IF NOT EXISTS gameboy_testing;
    GRANT ALL PRIVILEGES ON \`gameboy_testing%\`.* TO '$MYSQL_USER'@'%';
EOSQL

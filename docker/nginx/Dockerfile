FROM nginx

LABEL maintainer="Michael Dzjaparidze"

ENV TZ=UTC

RUN ln --force --no-dereference --symbolic /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

RUN apt-get update && apt-get install --yes openssl \
    && apt-get autoremove --yes && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN rm --force --recursive /etc/nginx/conf.d/*
COPY create-certificate /docker-entrypoint.d/create-certificate.sh
COPY gameboy.conf /etc/nginx/conf.d/gameboy.conf
RUN chmod +x /docker-entrypoint.d/create-certificate.sh

EXPOSE 80 81 443

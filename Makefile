NAME		= ft_transcendence
COMPOSE		= docker compose

all: up

up:
	$(COMPOSE) up --build

detached:
	$(COMPOSE) up --build -d

down:
	$(COMPOSE) down

stop:
	$(COMPOSE) stop

start:
	$(COMPOSE) start

clean:
	$(COMPOSE) down -v

fclean: clean
	$(COMPOSE) down -v --rmi all --remove-orphans

re: fclean all

.PHONY: all up detached down stop start clean fclean re

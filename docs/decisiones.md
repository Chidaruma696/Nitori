# Decisiones

Por qué Nitori es como es.

## Web Serial y no un servicio local

Un programa en la PC que lea el puerto y lo pase por WebSocket funciona en cualquier navegador, pero hay que instalarlo, mantenerlo vivo y abrirle un puerto. Con Web Serial la página habla directo con la báscula y no hay nada que instalar. El precio es que solo funciona en Chrome y Edge de escritorio.

## Sondear sin esperar al write

La Torrey solo contesta cuando se le pregunta. Al principio el sondeo hacía `await write`, y cuando el USB se atoraba el lock del escritor se quedaba tomado para siempre: los sondeos siguientes fallaban sin ruido y la báscula parecía muerta. Ahora el write se encola, el lock se suelta al momento y, si se acumulan tres sin aceptar, se deja de insistir y el vigilante reabre el puerto.

## El estabilizador no usa reloj propio

Recibe la marca de tiempo de cada lectura. Así se prueba sin esperar de verdad y da igual de dónde venga el tiempo. Los números (3 g, 800 ms, 20 g, 60 %) salieron de pesar con la Torrey en uso diario, y todos son opciones.

## Retiro por el 60 %

Si alguien pone un segundo paquete sin quitar el primero, el peso sube y no baja de 20 g, así que nunca se "retiraba". Con el 60 % basta con quitar la mayor parte para que cuente.

## Vigilante de silencio

A veces la báscula deja de mandar tramas sin que el puerto se cierre. Si pasan 4 s sin oír nada, se reabre como si se hubiera caído. También procesa una trama que se quedó en el buffer sin salto de línea, para que no espere para siempre.

## Mensajes en inglés y traducibles

Los mensajes de estado eran en español y fijos. Ahora vienen en inglés y se pasan los que quieras con `messages`; la demo trae el juego en español. Solo los textos para personas: los nombres de eventos y estados (`connected`, `stable`...) no se traducen porque son API.

## Un solo archivo y dist/ en el repo

Es una librería chica y sin dependencias; partirla en módulos y meter un bundler era más trabajo que el código. `scripts/build.py` hace la versión UMD quitando `export` y envolviéndola, y la CI comprueba que `dist/` esté al día.

## Sin Lisp aquí

Chimata describe sus formatos en Lisp porque cada báscula imprime el código a su manera. Aquí solo conozco una trama, la de la Torrey; si aparece otra marca que hable distinto, se piensa entonces si conviene describirla igual o basta con la opción `parser`.

## Lo que no me convence todavía

- Solo está probada con una Torrey L-PCR. Otros modelos pueden mandar la trama distinta.
- Los tests del vigilante esperan de verdad (unos segundos); habría que inyectarle el reloj como al estabilizador.

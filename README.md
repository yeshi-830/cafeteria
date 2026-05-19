# cafeteria<!DOCTYPE html>
<html>
<head>
  <title>Simple Calculator</title>

  <style>
    body {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      background: #f2f2f2;
      font-family: Arial;
    }

    .calculator {
      background: white;
      padding: 20px;
      border-radius: 10px;
      box-shadow: 0px 0px 10px gray;
    }

    #display {
      width: 100%;
      height: 50px;
      margin-bottom: 10px;
      font-size: 24px;
      text-align: right;
      padding-right: 10px;
    }

    .buttons {
      display: grid;
      grid-template-columns: repeat(4, 70px);
      gap: 10px;
    }

    button {
      height: 60px;
      font-size: 20px;
      border: none;
      border-radius: 8px;
      background: #4CAF50;
      color: white;
      cursor: pointer;
    }

    button:hover {
      background: #45a049;
    }

    .equal {
      background: orange;
    }

    .clear {
      background: red;
    }
  </style>
</head>

<body>

<div class="calculator">
  <input type="text" id="display" disabled>

  <div class="buttons">
    <button onclick="appendValue('7')">7</button>
    <button onclick="appendValue('8')">8</button>
    <button onclick="appendValue('9')">9</button>
    <button onclick="appendValue('/')">/</button>

    <button onclick="appendValue('4')">4</button>
    <button onclick="appendValue('5')">5</button>
    <button onclick="appendValue('6')">6</button>
    <button onclick="appendValue('*')">*</button>

    <button onclick="appendValue('1')">1</button>
    <button onclick="appendValue('2')">2</button>
    <button onclick="appendValue('3')">3</button>
    <button onclick="appendValue('-')">-</button>

    <button onclick="appendValue('0')">0</button>
    <button onclick="appendValue('.')">.</button>
    <button class="equal" onclick="calculate()">=</button>
    <button onclick="appendValue('+')">+</button>

    <button class="clear" onclick="clearDisplay()">C</button>
  </div>
</div>

<script>
  function appendValue(value) {
    document.getElementById("display").value += value;
  }

  function calculate() {
    let result = eval(document.getElementById("display").value);
    document.getElementById("display").value = result;
  }

  function clearDisplay() {
    document.getElementById("display").value = "";
  }
</script>

</body>
</html>

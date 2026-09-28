pipeline {
  agent any
  options {
    disableConcurrentBuilds()
    timestamps()
    timeout(time: 30, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }
  parameters {
    booleanParam(name: 'DEPLOY_AFTER_BUILD', defaultValue: false, description: 'Deploy the successful build to MemoryPlace')
  }
  stages {
    stage('Source') {
      steps {
        dir('source') {
          sh '''
            set -eu
            if [ -d .git ]; then
              git fetch --depth 1 origin main
              git checkout --detach FETCH_HEAD
            else
              git clone --depth 1 --branch main https://github.com/kyoungrae/MemoryPlace.git .
            fi
          '''
        }
      }
    }
    stage('Build and typecheck') {
      steps {
        dir('source') {
          sh 'docker build --pull --target build -t memoryplace/build:${BUILD_NUMBER} .'
        }
      }
    }
    stage('Integration tests') {
      steps {
        dir('source') {
          sh 'sh scripts/test-image.sh memoryplace/build:${BUILD_NUMBER} ${BUILD_NUMBER}'
        }
      }
    }
    stage('Release image') {
      steps {
        dir('source') {
          sh 'docker build -t memoryplace/app:${BUILD_NUMBER} .'
        }
      }
    }
    stage('Deploy') {
      when { expression { params.DEPLOY_AFTER_BUILD } }
      steps {
        dir('source') {
          sh 'sh scripts/deploy.sh memoryplace/app:${BUILD_NUMBER}'
        }
      }
    }
  }
}
